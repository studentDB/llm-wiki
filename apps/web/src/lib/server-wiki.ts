// Server-only helpers that resolve the active wiki path and open the
// per-wiki resources (settings + SQLite). Used by API routes; not for
// client components.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { redirect } from "next/navigation";
import { NextResponse } from "next/server";

import {
  backfillUsageCosts,
  ensureWikiSettings,
  getApiKey,
  globalConfigPath,
  initWikiFolder,
  openDb,
  purgeOldTrash,
  syncWikiToDb,
  type Db,
  type WikiSettings,
} from "@llm-wiki/core";
import {
  getRuntimeConfig,
  isKnownProduct,
  knownProducts,
  resolveProductWikiDir,
} from "@llm-wiki/llm";

import {
  WikiRoutingError,
  describeRoutingError,
  selectWikiTarget,
  type WikiRoutingDeps,
} from "./wiki-routing";

// Throttle the trash purge so we don't crawl the trash dir on every API call.
// One purge per process per hour is plenty for V1.
let lastPurgeMs = 0;
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

// Track which wikis we've already cost-backfilled this process lifetime.
// Backfill is for rows from the pre-fix era (where every insertUsage hard-
// coded cost_cents: null); once per wiki per process is enough. Switching
// wikis adds the new path to the set on first open.
const backfilledWikis = new Set<string>();

import { headers } from "next/headers";

/**
 * Resolution order (docs/13-multi-wiki.md):
 * 0. `X-Wiki-Product` HTTP header — for stateless multi-tenant API routing.
 *    When the runtime config declares `wiki.products`, the value is checked
 *    against that allow-list first so a typo can't silently mint an empty wiki.
 * 1. `LLM_WIKI_PATH` env var — explicit override, wins. Useful for CI,
 *    scripting, and the CLI's `start <folder>` form.
 * 2. `activeWiki` in `~/.llm-wiki/config.json` — set by the WikiSwitcher /
 *    Settings → Wikis picker. An explicit choice the user made at runtime,
 *    so it outranks the deployment default. (It used to sit BELOW
 *    `defaultProduct`, which made the switcher visually switch while every
 *    page kept rendering the pinned default — the ConST560/ConST326 bug.)
 * 3. `defaultProduct` in `llm-wiki.config.json` — the deployment's pinned
 *    fallback, ships with the artifact so a one-click launch lands somewhere
 *    useful even before the user has picked anything.
 * 4. `~/llm-wiki-default` — first-run fallback so the app boots usefully
 *    before the user has named a wiki.
 *
 * Sync read of the config file because this runs inside server-component
 * render paths and we don't want to make every page async on a tiny,
 * OS-cached JSON file. Failures fall through to the default silently.
 */
/**
 * The actual decision tree lives in `./wiki-routing.ts` as a pure function so
 * it can be unit tested without mocking Next.js. This only wires real IO into
 * it. See `wiki-routing.test.ts` for the pinned ordering.
 */
function routingDeps(): WikiRoutingDeps {
  return {
    defaultProduct: getRuntimeConfig().wiki.defaultProduct,
    isKnownProduct,
    productDir: resolveProductWikiDir,
    homeFallback: join(homedir(), "llm-wiki-default"),
  };
}

/** Active wiki recorded by the picker, or null. Sync read; see note above. */
function readActiveWiki(): string | null {
  try {
    const raw = readFileSync(globalConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as { activeWiki?: unknown };
    if (typeof parsed.activeWiki === "string" && parsed.activeWiki.length > 0) {
      return parsed.activeWiki;
    }
  } catch {
    // ENOENT (no config yet) or malformed JSON — fall through to default.
  }
  return null;
}

export function resolveWikiPath(): string {
  // Only headers() is guarded: it throws outside a Next.js request context
  // (CLI, non-request async work). Product resolution deliberately sits OUTSIDE
  // this try — it used to be inside, which silently swallowed the allow-list
  // error and fell through to the default wiki instead of reporting a typo.
  let product: string | null = null;
  try {
    product = headers().get("x-wiki-product");
  } catch {
    // Not in a request scope — fall through to env/config resolution.
  }

  try {
    return selectWikiTarget(
      {
        headerProduct: product,
        envPath: process.env["LLM_WIKI_PATH"] ?? null,
        activeWiki: readActiveWiki(),
      },
      routingDeps(),
    ).path;
  } catch (err) {
    // Translate the pure routing error into the HTTP-facing one, keeping the
    // actionable allow-list message.
    if (err instanceof WikiRoutingError) {
      throw new WikiProductError(describeRoutingError(err, knownProducts));
    }
    throw err;
  }
}

/**
 * What "no wiki selected" means, shared by the wikis list / dashboard so their
 * notion of the default matches `resolveWikiPath()`: the deployment-pinned
 * `defaultProduct` if configured, else the first-run folder.
 */
export function fallbackWikiPath(): string {
  return selectWikiTarget(
    { headerProduct: null, envPath: null, activeWiki: null },
    routingDeps(),
  ).path;
}

/**
 * Maps a product name to its wiki directory using the configured `baseDir`
 * (resolved relative to the config file, so the artifact stays portable).
 * Throws when the product isn't in the configured allow-list — that guard is
 * what stops a stray `X-Wiki-Product: Const326` from creating junk.
 */
export function resolveProductPathOrThrow(product: string): string {
  if (!isKnownProduct(product)) {
    const known = (knownProducts() ?? []).join(", ");
    throw new WikiProductError(
      `Unknown wiki product "${product}". Known products (from llm-wiki.config.json → wiki.products): ${known || "(none declared)"}. Add it to the config or remove the X-Wiki-Product header.`,
    );
  }
  return resolveProductWikiDir(product);
}

export class WikiProductError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WikiProductError";
  }
}

/**
 * Routes call this right after `resolveWikiPath()` / `openWikiContext()` so a
 * mistyped `X-Wiki-Product` surfaces as an actionable 400 instead of a 500
 * stack trace. Returns null for anything that isn't a product error, so it
 * composes with the caller's existing error handling.
 */
export function wikiProductErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof WikiProductError) {
    return NextResponse.json(
      { ok: false, error: err.message, code: "UNKNOWN_WIKI_PRODUCT" },
      { status: 400 },
    );
  }
  return null;
}

export type WikiContext = {
  wikiPath: string;
  db: Db;
  settings: WikiSettings;
};

/**
 * Ensures the wiki folder is initialized, opens the DB, runs an idempotent
 * sync from disk, and returns the per-request context.
 *
 * The DB connection stays open for the lifetime of the request — callers
 * MUST close it when done (typical pattern: try/finally in the route).
 */
export async function openWikiContext(): Promise<WikiContext> {
  const wikiPath = resolveWikiPath();
  await initWikiFolder(wikiPath); // idempotent
  const db = openDb(wikiPath);
  try {
    await syncWikiToDb(wikiPath, db);
  } catch (err) {
    db.close();
    throw err;
  }
  // Materialise the wiki's own settings.json the first time it's opened, so a
  // wiki created straight from a deployment (or one whose folder was created
  // outside the app) owns an inspectable config instead of silently re-deriving
  // defaults from llm-wiki.config.json on every request.
  const { settings, created } = await ensureWikiSettings(wikiPath);
  if (created) {
    console.log(`[wiki] wrote default settings.json for ${wikiPath}`);
  }

  // Best-effort 30-day trash cleanup. Throttled, errors ignored.
  if (Date.now() - lastPurgeMs > PURGE_INTERVAL_MS) {
    lastPurgeMs = Date.now();
    purgeOldTrash(wikiPath).catch(() => {});
  }

  // One-shot cost backfill per wiki per process. Picks up any usage rows
  // from before the cost_cents fix (2026-05-24) and fills them in from
  // the pricing table. NULL stays NULL for unknown models.
  if (!backfilledWikis.has(wikiPath)) {
    backfilledWikis.add(wikiPath);
    try {
      backfillUsageCosts(db);
    } catch {
      // Non-fatal — dashboard just shows a smaller cumulative.
    }
  }

  return { wikiPath, db, settings };
}

/**
 * Page-level redirect gate for protected routes — the equivalent of the
 * `next/navigation` middleware pattern, but since Next 14 middleware runs
 * on the Edge runtime (no `node:fs` access to `~/.llm-wiki/config.json`)
 * we do the check in each protected page's server component instead.
 *
 * Drops the user back at `/` if either:
 * - no OpenRouter API key is configured (any operation would fail loud)
 * - the active wiki has no topic set (the LLM has no scope to work in)
 *
 * `/` itself runs the onboarding wizard for these cases, so this is a
 * one-line redirect at the top of each protected page.
 *
 * Pages that opt in: `/wiki`, `/wiki/[slug]`, `/sources`, `/sources/[id]`,
 * `/query`, `/chats`, `/chats/[id]`, `/lint`, `/log`, `/graph`, `/schema`.
 * Pages that don't: `/`, `/about`, `/help`, `/developers`, `/settings`
 * (the user needs to be able to reach Settings to configure things).
 */
export async function requireSetup(slot?: keyof WikiSettings["defaultModels"]): Promise<void> {
  const [apiKeyStatus, { settings }] = await Promise.all([
    getApiKey(),
    ensureWikiSettings(resolveWikiPath()),
  ]);
  const hasKey = !!apiKeyStatus.key;

  let needsKey = false;
  if (slot) {
    needsKey = settings.defaultModels[slot].provider === "openrouter" && !hasKey;
  }

  const needsTopic = settings.topic.trim().length === 0;
  if (needsTopic) {
    redirect("/");
  } else if (needsKey) {
    redirect("/?needsKey=1");
  }
}
