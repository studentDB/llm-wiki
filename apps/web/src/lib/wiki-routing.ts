// The wiki-path resolution PRIORITY CONTRACT, expressed as one pure function.
//
// Why this exists as a module with no Next.js imports: the ordering below is
// easy to get wrong and the failure mode is silent — the UI appears to switch
// wikis while every page keeps rendering another one. That exact bug shipped
// once (`defaultProduct` outranking `activeWiki`, so a deployment-pinned
// default beat whatever the user had just picked). Keeping the decision tree
// free of `next/headers`, `node:fs`, and singletons means it can be unit
// tested with zero mocks, so the ordering is pinned by tests rather than by
// whoever edits next.
//
// Highest priority first:
//   1. `X-Wiki-Product` header  — stateless per-request routing (CLI, scripts)
//   2. `LLM_WIKI_PATH` env      — explicit override (CI, `start <folder>`)
//   3. `activeWiki`             — the user's runtime pick, saved by the picker
//   4. `defaultProduct`         — the deployment's pinned fallback
//   5. home fallback            — first run, nothing configured yet
//
// The rule behind the ordering: an explicit, more specific choice always wins
// over a broader default. A request-scoped header beats a process-wide env;
// a user's live choice beats anything shipped in the artifact.

/** Everything `selectWikiTarget` needs, injected so tests need no mocking. */
export type WikiRoutingDeps = {
  /** `wiki.defaultProduct` from llm-wiki.config.json (null when unset). */
  defaultProduct: string | null;
  /** Allow-list check. Returns true when no allow-list is configured. */
  isKnownProduct: (product: string) => boolean;
  /** Maps a product name to its absolute wiki directory. */
  productDir: (product: string) => string;
  /** Absolute path used when nothing else applies. Usually `~/llm-wiki-default`. */
  homeFallback: string;
};

/** Inputs gathered from the request / env / global config. All nullable. */
export type WikiRoutingInput = {
  headerProduct: string | null;
  envPath: string | null;
  activeWiki: string | null;
};

export type WikiTarget =
  | { source: "header"; product: string; path: string }
  | { source: "env"; path: string }
  | { source: "active-wiki"; path: string }
  | { source: "default-product"; product: string; path: string }
  | { source: "home-fallback"; path: string };

/**
 * Unknown-product guard. Lives here (not one level up in the caller's try/catch)
 * because swallowing it is what turns a typo into a mystery: it used to land in
 * a `catch` around `headers()`, so `X-Wiki-Product: Const326` silently served
 * the default wiki instead of reporting an unknown product.
 */
export class WikiRoutingError extends Error {
  constructor(
    message: string,
    readonly product: string,
  ) {
    super(message);
    this.name = "WikiRoutingError";
  }
}

/**
 * Pure resolution. Throws `WikiRoutingError` when the header names a product
 * outside the configured allow-list. Everything else degrades to a lower
 * priority source rather than failing.
 */
export function selectWikiTarget(input: WikiRoutingInput, deps: WikiRoutingDeps): WikiTarget {
  if (input.headerProduct) {
    const product = input.headerProduct;
    if (!deps.isKnownProduct(product)) {
      // The caller turns this into a 400 with the allow-list in the message.
      throw new WikiRoutingError(`Unknown wiki product "${product}".`, product);
    }
    return { source: "header", product, path: deps.productDir(product) };
  }

  if (input.envPath) return { source: "env", path: input.envPath };
  if (input.activeWiki) return { source: "active-wiki", path: input.activeWiki };

  if (deps.defaultProduct) {
    const product = deps.defaultProduct;
    return { source: "default-product", product, path: deps.productDir(product) };
  }

  return { source: "home-fallback", path: deps.homeFallback };
}

/** Shape used by the allow-list error message / 400 body. */
export function describeRoutingError(
  err: WikiRoutingError,
  knownProducts: () => string[] | null,
): string {
  const known = (knownProducts() ?? []).join(", ");
  return (
    `Unknown wiki product "${err.product}". Known products (from llm-wiki.config.json ` +
    `→ wiki.products): ${known || "(none declared)"}. Add it to the config or remove ` +
    `the X-Wiki-Product header.`
  );
}
