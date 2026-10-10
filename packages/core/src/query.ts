import { callLLM, estimateCostCents, type LlmClient } from "@llm-wiki/llm";

import type { Db } from "./db";
import { searchPages } from "./db-pages";
import { insertUsage } from "./db-usage";
import { buildQueryPrompt } from "./prompts/query";
import type { ExistingPageSnippet } from "./prompts/ingest";
import { QueryResponseSchema, type QueryResponse } from "./schema";
import { listPages, readIndex, readPage, readSchema } from "./wiki";

const TOP_K_RELEVANT_PAGES = 10;

export type QueryProgressEvent =
  | { phase: "context"; message: string }
  | { phase: "llm"; message: string }
  | { phase: "done"; result: QueryResponse };

export type QueryWikiOptions = {
  question: string;
  wikiPath: string;
  db: Db;
  client: LlmClient;
  /** Per docs/05, use the query model slot (defaults to a smart model). */
  model: string;
  onProgress?: (event: QueryProgressEvent) => void;
};

/**
 * Answers a one-off question against the wiki. Pure read path — never writes
 * pages. The caller decides whether to promote suggestedNewPage via createPage.
 */
export async function queryWiki(opts: QueryWikiOptions): Promise<QueryResponse> {
  if (!opts.question.trim()) {
    throw new Error("queryWiki: question must be non-empty");
  }

  opts.onProgress?.({ phase: "context", message: "Loading wiki schema and index..." });

  const [schema, index] = await Promise.all([
    readSchemaOrDefault(opts.wikiPath),
    readIndexOrDefault(opts.wikiPath),
  ]);

  opts.onProgress?.({ phase: "context", message: "Searching for relevant pages..." });
  const relevantPages = await loadRelevantPages(opts.wikiPath, opts.db, opts.question);

  opts.onProgress?.({ phase: "llm", message: `Calling ${opts.model}...` });

  const prompt = buildQueryPrompt({
    schema,
    index,
    relevantPages,
    question: opts.question,
  });

  logQueryPrompt(opts.model, prompt);

  const result = await callLLM({
    client: opts.client,
    model: opts.model,
    system: prompt.system,
    user: prompt.user,
    schema: QueryResponseSchema,
  });

  insertUsage(opts.db, {
    operation: "query",
    model: result.model,
    input_tokens: result.usage.inputTokens,
    output_tokens: result.usage.outputTokens,
    cost_cents: estimateCostCents(
      result.model,
      result.usage.inputTokens,
      result.usage.outputTokens,
    ),
    created_at: new Date().toISOString(),
  });

  opts.onProgress?.({ phase: "done", result: result.data });
  return result.data;
}

// ---- internals ------------------------------------------------------------

function logQueryPrompt(model: string, prompt: { system: string; user: string }): void {
  if (process.env.LLM_WIKI_LOG_QUERY_PROMPT !== "1") return;

  console.info("\n========== LLM WIKI QUERY PROMPT BEGIN ==========");
  console.info(`[model]\n${model}`);
  console.info(`[system]\n${prompt.system}`);
  console.info(`[user]\n${prompt.user}`);
  console.info("========== LLM WIKI QUERY PROMPT END ==========\n");
}

async function readSchemaOrDefault(wikiPath: string): Promise<string> {
  try {
    return await readSchema(wikiPath);
  } catch {
    return "(no schema set yet — assume a general-purpose personal wiki)";
  }
}

async function readIndexOrDefault(wikiPath: string): Promise<string> {
  try {
    return await readIndex(wikiPath);
  } catch {
    return "(no index yet)";
  }
}

async function loadRelevantPages(
  wikiPath: string,
  db: Db,
  question: string,
): Promise<ExistingPageSnippet[]> {
  const selected = new Map<string, { slug: string; title: string }>();
  let mode: "explicit-links" | "exact-mentions" | "fts" | "fts+mentions" =
    "explicit-links";
  // Counted separately from slug mentions — see the top-up guard below.
  let deliberateHitCount = 0;

  // Explicit wiki links are authoritative and should never depend on FTS.
  for (const slug of extractWikiSlugs(question)) {
    selected.set(slug, { slug, title: slug });
  }
  const explicitLinkCount = selected.size;

  // Resolve literal page slugs and titles against pages on disk. This also
  // works when the SQLite cache is stale or has not been rebuilt yet.
  if (selected.size === 0) {
    mode = "exact-mentions";
    const pagesOnDisk = await listPages(wikiPath);
    const mentionedSlugs = new Set(question.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? []);
    const normalizedQuestion = normalizeForMentionMatch(question);
    for (const page of pagesOnDisk) {
      const title = normalizeForMentionMatch(page.title);
      const bySlug = mentionedSlugs.has(page.slug);
      const byTitle = title.length > 0 && normalizedQuestion.includes(title);
      if (bySlug || byTitle) {
        selected.set(page.slug, { slug: page.slug, title: page.title });
        if (isDeliberateMention(page.slug, page.title, byTitle)) {
          deliberateHitCount += 1;
        }
      }
    }
  }

  // Never widen an explicit scope, even if the selected file cannot be read.
  // Reject oversized exact selections instead of silently dropping pages.
  if (selected.size > TOP_K_RELEVANT_PAGES) {
    throw new Error(
      `Query selected ${selected.size} explicit pages; please request at most ${TOP_K_RELEVANT_PAGES} pages at a time.`,
    );
  }
  // A bare product name that collides with a page slug ("ConST810" -> const810)
  // shows up in nearly every question. Treating that as an explicit scope
  // starved answers of every sibling page, so FTS still runs and tops the
  // selection up. Only [[wiki links]] and deliberate mentions (a full title or
  // a full multi-segment slug) are allowed to narrow the scope.
  if (
    explicitLinkCount === 0 &&
    deliberateHitCount === 0 &&
    selected.size < TOP_K_RELEVANT_PAGES
  ) {
    mode = selected.size === 0 ? "fts" : "fts+mentions";
    let hits: Array<{ slug: string; title: string }> = [];
    try {
      hits = searchPages(db, question, TOP_K_RELEVANT_PAGES);
    } catch {
      hits = [];
    }

    for (const hit of hits) {
      if (selected.size >= TOP_K_RELEVANT_PAGES) break;
      selected.set(hit.slug, hit);
    }
  }

  const snippets: ExistingPageSnippet[] = [];
  const unreadableSlugs: string[] = [];
  for (const hit of selected.values()) {
    try {
      const page = await readPage(wikiPath, hit.slug);
      snippets.push({
        slug: page.slug,
        title: page.frontmatter.title,
        type: page.frontmatter.type,
        excerpt: page.content,
      });
    } catch {
      // Missing or malformed is not permission to substitute another page.
      unreadableSlugs.push(hit.slug);
    }
  }
  if (process.env.LLM_WIKI_LOG_QUERY_PROMPT === "1") {
    console.info(
      "[query retrieval]",
      JSON.stringify({
        mode,
        selectedSlugs: [...selected.keys()],
        retrievedSlugs: snippets.map((page) => page.slug),
        unreadableSlugs,
      }),
    );
  }
  return snippets;
}

function extractWikiSlugs(question: string): string[] {
  return Array.from(question.matchAll(/\[\[([a-z0-9-]+)(?:\|[^\]]+)?\]\]/gi), (match) =>
    match[1]!.toLowerCase(),
  );
}

/**
 * Decide whether naming this page is a deliberate "answer from THIS page only"
 * scope, versus a product name dropped in passing. The measure is how much the
 * user actually typed, not what the slug looks like:
 *
 *   - a multi-segment slug typed out in full ("issue-hart-poc-gaps") — deliberate
 *   - a descriptive title ("HART 章节试点证据缺口", "Shor's Algorithm") — deliberate
 *   - a single bare word ("ConST810", "Operation") — NOT deliberate
 *
 * The last case is the bug f480fb8 fixed: a product name shows up in nearly
 * every question, so narrowing on it answered from the product page alone and
 * starved every sibling page out of the context.
 */
function isDeliberateMention(slug: string, title: string, byTitle: boolean): boolean {
  if (slug.includes("-")) return true;
  if (!byTitle) return false;

  const latinWords = title.match(/[A-Za-z0-9]+/g)?.length ?? 0;
  const cjkChars = title.match(/\p{Script=Han}/gu)?.length ?? 0;
  return latinWords >= 2 || cjkChars >= 4;
}

function normalizeForMentionMatch(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}
