import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { NextResponse } from "next/server";

import {
  SCHEMA_TEMPLATES,
  WIKI_PATHS,
  getSchemaTemplate,
  initWikiFolder,
  loadWikiSettings,
  resolveDefaultWikiSettings,
  saveWikiSettings,
  setActiveWiki,
  type SchemaTemplateId,
} from "@llm-wiki/core";
import { getRuntimeConfig, productTemplate, productTopic, resolveProductWikiDir } from "@llm-wiki/llm";

export const dynamic = "force-dynamic";

/**
 * POST /api/wikis/init — create (or adopt) a wiki by **product name**.
 *
 * This is the unattended-deployment path. The existing `/api/wikis` create
 * action takes an absolute path, which a deployment script can't produce when
 * it doesn't know where the repo lives. Here the server resolves the path from
 * `llm-wiki.config.json → wiki.baseDir`, so a script only needs to name the
 * product:
 *
 *   curl -X POST localhost:3737/api/wikis/init \
 *        -H 'content-type: application/json' \
 *        -d '{"product":"ConST326"}'
 *
 * `topic` and `template` are optional: anything not supplied falls back to the
 * product's entry in `wiki.products`, which is what lets a fresh target
 * environment bootstrap itself from config alone.
 *
 * Idempotent — running it against an existing wiki repairs missing files and
 * re-applies the seed topic without wiping pages.
 */
export async function POST(req: Request) {
  let body: {
    product?: unknown;
    topic?: unknown;
    template?: unknown;
    activate?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "expected JSON body" }, { status: 400 });
  }

  const product = typeof body.product === "string" ? body.product.trim() : "";
  if (!product) {
    return NextResponse.json({ error: "`product` is required" }, { status: 400 });
  }

  // Refuse values that would escape baseDir (../../etc) — product names double
  // as directory names here.
  if (/[\\/]|\.\./.test(product)) {
    return NextResponse.json(
      { error: "`product` must be a plain name, not a path" },
      { status: 400 },
    );
  }

  const path = resolveProductWikiDir(product);

  // Seed values: explicit request > config entry > nothing.
  const cfgTopic = productTopic(product);
  const topicInput = typeof body.topic === "string" ? body.topic.trim() : "";
  const topic = topicInput || cfgTopic || "";

  const templateInput = typeof body.template === "string" ? body.template.trim() : "";
  const templateId = (templateInput || productTemplate(product) || "blank") as SchemaTemplateId;

  await initWikiFolder(path);

  // Stamp the CLAUDE.md contract so ingest has language/topic rules from page
  // one. This is the guard against the "entire wiki came out English" failure.
  if (templateId && templateId !== "blank") {
    const known = SCHEMA_TEMPLATES.find((t) => t.id === templateId);
    if (!known) {
      return NextResponse.json(
        {
          error: `unknown template "${templateId}"`,
          knownTemplates: SCHEMA_TEMPLATES.map((t) => t.id),
        },
        { status: 400 },
      );
    }
    const populated = getSchemaTemplate(templateId).body.replace(
      /## Topic\n\n\([^)]*\)/,
      `## Topic\n\n${topic}`,
    );
    await writeFile(join(path, WIKI_PATHS.schema), populated, "utf8");
  }

  const existing = await loadWikiSettings(path);
  await saveWikiSettings(path, {
    ...resolveDefaultWikiSettings(),
    ...existing,
    // Request/config topic wins, but never clobber a topic the wiki already has.
    topic: existing.topic.trim() || topic,
  });

  const activate = body.activate === undefined ? true : Boolean(body.activate);
  if (activate) await setActiveWiki(path);

  // A blank template means CLAUDE.md carries no language contract. Measured on
  // ConST860: ingesting against a blank English template produced a 0% Chinese
  // wiki that had to be re-ingested wholesale, versus ~85% once the contract
  // was written. Make that loud instead of letting it fail silently.
  const warnings: string[] = [];
  if (templateId === "blank") {
    warnings.push(
      "template \"blank\" ships no CLAUDE.md contract: ingest gets no language rule and may produce English pages. Pass `template`, declare wiki.products.<product>.template in llm-wiki.config.json, or write CLAUDE.md before ingesting.",
    );
    console.warn(
      `[wikis/init] product "${product}" initialized with the blank template — no language contract; ingest may come out English.`,
    );
  }
  if (!(existing.topic.trim() || topic)) {
    warnings.push(
      "no topic supplied and none configured: the first-run setup gate will prompt, and ingest has no scope constraint.",
    );
  }

  return NextResponse.json({
    ok: true,
    product,
    path,
    topic: existing.topic.trim() || topic,
    template: templateId,
    active: activate,
    configSource: getRuntimeConfig().source,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}
