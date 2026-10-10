import { NextResponse } from "next/server";

import {
  loadWikiSettings,
  resolveDefaultWikiSettings,
  saveWikiSettings,
  type ModelSlotConfig,
  type WikiSettings,
} from "@llm-wiki/core";

import { resolveWikiPath, wikiProductErrorResponse } from "@/lib/server-wiki";

export const dynamic = "force-dynamic";

/** Shared guard: an unknown X-Wiki-Product must read as a clear 400, not a 500. */
function guard(err: unknown): NextResponse | null {
  return wikiProductErrorResponse(err);
}

export async function GET() {
  let wikiPath: string;
  try {
    wikiPath = resolveWikiPath();
  } catch (err) {
    const res = guard(err);
    if (res) return res;
    throw err;
  }
  const settings = await loadWikiSettings(wikiPath);
  // Defaults now come from llm-wiki.config.json when present, so the UI's
  // "reset to default" affordance lands on the deployment's configured values
  // rather than the hard-coded fallbacks.
  return NextResponse.json({
    settings,
    wikiPath,
    defaults: resolveDefaultWikiSettings(),
  });
}

type PutBody = Partial<{
  topic: string;
  defaultModels: Partial<Record<keyof WikiSettings["defaultModels"], Partial<ModelSlotConfig>>>;
  autoLintAfterIngest: boolean;
  showCostEstimates: boolean;
  requireApprovalForIngest: boolean;
}>;

export async function PUT(req: Request) {
  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "expected JSON body" }, { status: 400 });
  }
  let wikiPath: string;
  try {
    wikiPath = resolveWikiPath();
  } catch (err) {
    const res = guard(err);
    if (res) return res;
    throw err;
  }
  const current = await loadWikiSettings(wikiPath);
  const next: WikiSettings = {
    version: 1,
    topic: typeof body.topic === "string" ? body.topic : current.topic,
    defaultModels: {
      ingest: { ...current.defaultModels.ingest, ...body.defaultModels?.ingest },
      query:  { ...current.defaultModels.query,  ...body.defaultModels?.query  },
      chat:   { ...current.defaultModels.chat,   ...body.defaultModels?.chat   },
      lint:   { ...current.defaultModels.lint,   ...body.defaultModels?.lint   },
      vision: { ...current.defaultModels.vision, ...body.defaultModels?.vision },
    },
    autoLintAfterIngest:
      typeof body.autoLintAfterIngest === "boolean"
        ? body.autoLintAfterIngest
        : current.autoLintAfterIngest,
    showCostEstimates:
      typeof body.showCostEstimates === "boolean"
        ? body.showCostEstimates
        : current.showCostEstimates,
    requireApprovalForIngest:
      typeof body.requireApprovalForIngest === "boolean"
        ? body.requireApprovalForIngest
        : current.requireApprovalForIngest,
  };
  await saveWikiSettings(wikiPath, next);
  // Return both the saved settings and the model defaults for the UI's
  // "reset to default" affordance.
  const defaults = resolveDefaultWikiSettings();
  return NextResponse.json({ ok: true, settings: next, defaults });
}
