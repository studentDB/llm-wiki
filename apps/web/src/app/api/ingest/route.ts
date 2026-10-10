import { extname } from "node:path";

import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  WIKI_PATHS,
  getApiKey,
  getSchemaTemplate,
  ingestPastedText,
  ingestSource,
  ingestVisionSource,
  markSourceIngested,
  saveRawSource,
  type ExtractedTextSource,
  type ExtractedVisionSource,
  type IngestResponse,
} from "@llm-wiki/core";
import {
  detectFormat,
  detectFormatFromUrl,
  extractDocx,
  extractHtml,
  extractImage,
  extractMarkdown,
  extractPdf,
  extractPlain,
  extractPptx,
  extractXlsx,
  fetchAndExtractUrl,
  type ExtractedSource,
} from "@llm-wiki/ingestion";
import { createClient, ContextLengthError, RateLimitError, UnknownModelError, ingestRouteFor } from "@llm-wiki/llm";

import { openWikiContext, resolveWikiPath, wikiProductErrorResponse } from "@/lib/server-wiki";

export const dynamic = "force-dynamic";
// Vision calls (large PDFs/images) can take 60s+; raise from default 10s.
export const maxDuration = 180;

type IngestJsonBody = {
  text?: string;
  url?: string;
  title?: string;
  model?: string;
};

export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") ?? "";

  const { key } = await getApiKey();
  const apiKey = key || "";

  try {
    if (contentType.startsWith("multipart/form-data")) {
      return await handleFileUpload(req, apiKey);
    }
    // Default: JSON body (pasted text or URL).
    let body: IngestJsonBody;
    try {
      body = (await req.json()) as IngestJsonBody;
    } catch {
      return NextResponse.json({ error: "expected JSON body or multipart upload" }, { status: 400 });
    }
    if (typeof body.url === "string" && body.url.trim()) {
      return await handleUrl(body.url.trim(), body.title, body.model, apiKey);
    }
    if (typeof body.text === "string" && body.text.trim()) {
      return await handleText(body.text, body.title, body.model, apiKey);
    }
    return NextResponse.json(
      { error: "request must include `text`, `url`, or a multipart `file`" },
      { status: 400 },
    );
  } catch (err) {
    const productErr = wikiProductErrorResponse(err);
    if (productErr) return productErr;
    return errorResponse(err);
  }
}

// ---- shared helpers -------------------------------------------------------

/**
 * Which model slot handles this source.
 *
 * Historically this came from `extracted.kind`: PDFs/images went to the vision
 * slot, everything else to ingest. That still works as the fallback, but it's
 * implicit. `ingestRouting` in llm-wiki.config.json now lets a deployment
 * declare the mapping per input format (e.g. pdf -> vision while docx/xlsx ->
 * ingest), so a mixed-batch upload splits to different models automatically.
 */
function slotForSource(format: string, kind: string): "vision" | "ingest" {
  const fallback: "vision" | "ingest" = kind === "vision" ? "vision" : "ingest";
  return ingestRouteFor(format, fallback);
}

/**
 * Warn instead of silently producing an English wiki.
 *
 * Verified failure mode: a wiki with no topic and a blank CLAUDE.md template
 * leaves the ingest LLM following its English-only system prompt — ConST860
 * came out 0% Chinese and had to be re-ingested wholesale. Catch it before we
 * spend the tokens.
 */
async function unconfiguredWikiWarning(wikiPath: string, topic: string): Promise<string | null> {
  if (topic.trim().length > 0) return null;
  try {
    const raw = (await readFile(join(wikiPath, WIKI_PATHS.schema), "utf8")).trim();
    const blank = getSchemaTemplate("blank").body.trim();
    if (raw.length === 0 || raw === blank) {
      return [
        "目标库尚未初始化：topic 为空且 CLAUDE.md 仍是空白模板，灌库结果极可能是英文。",
        "请在 llm-wiki.config.json 的 wiki.products 中预置 topic，或调用 POST /api/wikis/init 初始化后再灌库。",
      ].join(" ");
    }
  } catch {
    // No readable CLAUDE.md — treat as unconfigured too.
    return "目标库缺少可读的 CLAUDE.md 契约，建议先用 POST /api/wikis/init 初始化（可指定 template）。";
  }
  return null;
}

// ---- handlers -------------------------------------------------------------

async function handleText(
  text: string,
  title: string | undefined,
  modelOverride: string | undefined,
  apiKey: string,
): Promise<Response> {
  const ctx = await openWikiContext();
  const provider = ctx.settings.defaultModels.ingest.provider;
  if (provider === "openrouter" && !apiKey) {
    ctx.db.close();
    return NextResponse.json(
      { error: "OpenRouter API key not configured. Set one in Settings." },
      { status: 400 },
    );
  }
  const client = createClient(apiKey, provider);
  const model = modelOverride ?? ctx.settings.defaultModels.ingest.model;
  const dryRun = ctx.settings.requireApprovalForIngest;
  const warning = await unconfiguredWikiWarning(ctx.wikiPath, ctx.settings.topic);
  if (warning) console.warn(`[Ingest Route] ⚠️ ${warning}`);
  try {
    const result = await ingestPastedText({
      text,
      ...(title ? { title } : {}),
      wikiPath: ctx.wikiPath,
      db: ctx.db,
      client,
      model,
      dryRun,
    });
    return ingestSuccess({
      wikiPath: resolveWikiPath(),
      sourceId: result.sourceId,
      rawFilename: result.rawFilename,
      model,
      response: result.response,
      kind: dryRun ? "preview" : "applied",
      providerUsed: provider,
      ...(warning ? { warning } : {}),
    });
  } finally {
    ctx.db.close();
  }
}

async function handleUrl(
  url: string,
  titleOverride: string | undefined,
  modelOverride: string | undefined,
  apiKey: string,
): Promise<Response> {
  // Extract first (outside DB context) so failures don't leave dangling state.
  let extracted;
  try {
    extracted = await fetchAndExtractUrl(url);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message ?? "URL fetch failed", type: "FetchError" },
      { status: 400 },
    );
  }
  const title = titleOverride?.trim() || extracted.title;

  const ctx = await openWikiContext();
  const provider = ctx.settings.defaultModels.ingest.provider;
  if (provider === "openrouter" && !apiKey) {
    ctx.db.close();
    return NextResponse.json(
      { error: "OpenRouter API key not configured. Set one in Settings." },
      { status: 400 },
    );
  }
  const client = createClient(apiKey, provider);
  const model = modelOverride ?? ctx.settings.defaultModels.ingest.model;
  const dryRun = ctx.settings.requireApprovalForIngest;
  const warning = await unconfiguredWikiWarning(ctx.wikiPath, ctx.settings.topic);
  if (warning) console.warn(`[Ingest Route] ⚠️ ${warning}`);
  try {
    const saved = await saveRawSource({
      wikiPath: ctx.wikiPath,
      db: ctx.db,
      buffer: Buffer.from(extracted.content, "utf8"),
      ext: ".md",
      format: "url",
      title,
      url,
    });
    const response = await ingestSource({
      source: { content: extracted.content, title, format: "url" },
      wikiPath: ctx.wikiPath,
      db: ctx.db,
      client,
      model,
      sourceId: saved.sourceId,
      dryRun,
    });
    if (!dryRun) markSourceIngested(ctx.db, saved.sourceId);
    return ingestSuccess({
      wikiPath: resolveWikiPath(),
      sourceId: saved.sourceId,
      rawFilename: saved.rawFilename,
      model,
      kind: dryRun ? "preview" : "applied",
      response,
      providerUsed: provider,
      ...(warning ? { warning } : {}),
    });
  } finally {
    ctx.db.close();
  }
}

async function handleFileUpload(req: Request, apiKey: string): Promise<Response> {
  const form = await req.formData();
  const file = form.get("file");
  const titleOverride = (form.get("title") as string | null) ?? undefined;
  const modelOverride = (form.get("model") as string | null) ?? undefined;

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing `file` field in multipart body" }, { status: 400 });
  }

  const filename = file.name || "upload";
  const buffer = Buffer.from(await file.arrayBuffer());
  const format = detectFormat(filename, buffer);

  console.log(`\n[Ingest Route] 开始处理上传文件: ${filename} (格式: ${format})`);
  let extracted: ExtractedSource;
  try {
    console.log(`[Ingest Route] 正在提取 ${filename} 的文本内容...`);
    extracted = await runExtractor(format, buffer, filename);
    console.log(`[Ingest Route] ${filename} 文本提取完成，准备存入数据库并调用模型...`);
  } catch (err) {
    console.error(`[Ingest Route] 提取失败: ${err}`);
    return NextResponse.json(
      { error: `extraction failed for ${format}: ${(err as Error).message}` },
      { status: 400 },
    );
  }

  const title = titleOverride?.trim() || extracted.title;
  if ("title" in extracted) extracted.title = title;

  const ctx = await openWikiContext();

  // Route by declared format->slot mapping (falls back to kind-based routing).
  // This is what lets one deployment send PDFs to a vision model while
  // docx/xlsx go to a text-only model, with no per-request intervention.
  const slot = slotForSource(format, extracted.kind);
  const provider = ctx.settings.defaultModels[slot].provider;
  if (provider === "openrouter" && !apiKey) {
    ctx.db.close();
    return NextResponse.json(
      { error: "OpenRouter API key not configured. Set one in Settings." },
      { status: 400 },
    );
  }
  const client = createClient(apiKey, provider);
  // An explicit `model` field only overrides the slot that will actually run —
  // previously it clobbered both, silently pointing text files at a vision model.
  const activeModel = modelOverride ?? ctx.settings.defaultModels[slot].model;
  const dryRun = ctx.settings.requireApprovalForIngest;
  const warning = await unconfiguredWikiWarning(ctx.wikiPath, ctx.settings.topic);
  if (warning) {
    console.warn(`[Ingest Route] ⚠️ ${warning}`);
  }

  try {
    const ext = extname(filename) || `.${format}`;
    const saved = await saveRawSource({
      wikiPath: ctx.wikiPath,
      db: ctx.db,
      buffer,
      ext,
      format,
      title,
      originalName: filename,
    });

    let response: IngestResponse;
    const modelUsed = activeModel;
    const isVision = extracted.kind === "vision";

    if (isVision && slot !== "vision") {
      // Config routes this format to a text slot, but the extractor only has
      // multimodal bytes — there is no text content to send. Fail loudly rather
      // than silently dropping the file.
      return NextResponse.json(
        {
          error: `llm-wiki.config.json 的 ingestRouting 把 "${format}" 指向 ${slot} 槽，但该格式只有多模态载荷（无文本内容）。请改为 "vision"。`,
          type: "IngestRoutingError",
        },
        { status: 400 },
      );
    }

    if (isVision) {
      response = await ingestVisionSource({
        source: extracted as ExtractedVisionSource,
        wikiPath: ctx.wikiPath,
        db: ctx.db,
        client,
        model: activeModel,
        sourceId: saved.sourceId,
        dryRun,
      });
    } else {
      // Text extraction succeeded; `slot` decides which model reads it. A text
      // format routed to the vision slot still goes down the text pipeline —
      // it just runs with a vision-capable model, which is harmless.
      response = await ingestSource({
        source: { content: (extracted as ExtractedTextSource).content, title, format },
        wikiPath: ctx.wikiPath,
        db: ctx.db,
        client,
        model: activeModel,
        sourceId: saved.sourceId,
        dryRun,
      });
    }
    if (!dryRun) markSourceIngested(ctx.db, saved.sourceId);
    
    console.log(
      `[Ingest Route] ${filename} → slot=${slot} provider=${provider} model=${modelUsed}，处理完成\n`,
    );

    return ingestSuccess({
      wikiPath: resolveWikiPath(),
      sourceId: saved.sourceId,
      rawFilename: saved.rawFilename,
      model: modelUsed,
      response,
      kind: dryRun ? "preview" : "applied",
      providerUsed: provider,
      ...(warning ? { warning } : {}),
    });
  } finally {
    ctx.db.close();
  }
}

// ---- helpers --------------------------------------------------------------

async function runExtractor(
  format: ReturnType<typeof detectFormat>,
  buffer: Buffer,
  filename: string,
): Promise<ExtractedSource> {
  switch (format) {
    case "md":
      return extractMarkdown(buffer, filename);
    case "txt":
      return extractPlain(buffer, filename);
    case "html":
      return extractHtml(buffer);
    case "url":
      // URL detection only happens via URL string, not via uploaded file.
      // If we somehow get here, fall back to HTML.
      return extractHtml(buffer);
    case "docx":
      return extractDocx(buffer, filename);
    case "pptx":
      return extractPptx(buffer, filename);
    case "xlsx":
      return extractXlsx(buffer, filename);
    case "pdf":
      return extractPdf(buffer, filename);
    case "image":
      return extractImage(buffer, filename);
    default: {
      // Exhaustiveness check.
      const _exhaustive: never = format;
      void _exhaustive;
      throw new Error(`unsupported format: ${String(format)}`);
    }
  }
}

function ingestSuccess(args: {
  wikiPath: string;
  sourceId: string;
  rawFilename: string;
  model: string;
  response: IngestResponse;
  kind: "applied" | "preview";
  providerUsed?: string;
  /** Set when the target wiki looks uninitialized (see unconfiguredWikiWarning). */
  warning?: string | null;
}) {
  return NextResponse.json({
    ok: true,
    kind: args.kind,
    wikiPath: args.wikiPath,
    sourceId: args.sourceId,
    rawFilename: args.rawFilename,
    model: args.model,
    providerUsed: args.providerUsed,
    ...(args.warning ? { warning: args.warning } : {}),
    // Short-form response (always returned) — drives the user-facing
    // summary UI. When kind === "preview", the client also reads
    // `fullResponse` below so it can re-send the proposal to
    // /api/ingest/apply unchanged.
    response: {
      summary: args.response.summary,
      newPages: args.response.newPages.map((p) => ({
        slug: p.slug,
        title: p.title,
        type: p.type,
      })),
      pageUpdates: args.response.pageUpdates.map((p) => ({
        slug: p.slug,
        updateReason: p.updateReason,
      })),
      contradictions: args.response.contradictions,
    },
    fullResponse: args.kind === "preview" ? args.response : null,
  });
}

function errorResponse(err: unknown): Response {
  const productErr = wikiProductErrorResponse(err);
  if (productErr) return productErr;
  const status =
    err instanceof ContextLengthError || err instanceof UnknownModelError
      ? 400
      : err instanceof RateLimitError
        ? 429
        : 500;
  return NextResponse.json(
    {
      ok: false,
      error: (err as Error).message ?? "ingest failed",
      type: (err as Error).name ?? "Error",
    },
    { status },
  );
}

// Tell Next.js this is a JS-only route; no caching, no static export.
export {};
