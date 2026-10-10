import { describe, expect, it } from "vitest";

import {
  WikiRoutingError,
  describeRoutingError,
  selectWikiTarget,
  type WikiRoutingDeps,
  type WikiRoutingInput,
} from "./wiki-routing";

// The ordering below is a contract, not an implementation detail — each test
// pins one rung of the ladder so a reorder during a refactor fails loudly
// instead of quietly serving the wrong wiki.

const DEPS: WikiRoutingDeps = {
  defaultProduct: "ConST326",
  isKnownProduct: (p) => ["ConST326", "ConST560"].includes(p),
  productDir: (p) => `/repo/apps/web/wikis/${p}`,
  homeFallback: "/home/tester/llm-wiki-default",
};

function none(): WikiRoutingInput {
  return { headerProduct: null, envPath: null, activeWiki: null };
}

describe("selectWikiTarget priority", () => {
  it("X-Wiki-Product header beats every other source", () => {
    const target = selectWikiTarget(
      {
        headerProduct: "ConST560",
        envPath: "/env/wiki",
        activeWiki: "/active/wiki",
      },
      DEPS,
    );
    expect(target).toEqual({
      source: "header",
      product: "ConST560",
      path: "/repo/apps/web/wikis/ConST560",
    });
  });

  it("LLM_WIKI_PATH beats the user's saved active wiki", () => {
    const target = selectWikiTarget(
      { headerProduct: null, envPath: "/env/wiki", activeWiki: "/active/wiki" },
      DEPS,
    );
    expect(target).toEqual({ source: "env", path: "/env/wiki" });
  });

  it("REGRESSION: activeWiki beats defaultProduct", () => {
    // Shipped bug (2026-10-10): defaultProduct outranked activeWiki, so the
    // picker switched the label while every page kept rendering the pinned
    // default. If this test fails, the ordering got flipped again.
    const target = selectWikiTarget(
      { headerProduct: null, envPath: null, activeWiki: "/repo/apps/web/wikis/ConST560" },
      DEPS,
    );
    expect(target.source).toBe("active-wiki");
    expect(target.path).toBe("/repo/apps/web/wikis/ConST560");
  });

  it("defaultProduct is used only when nothing was chosen", () => {
    const target = selectWikiTarget(none(), DEPS);
    expect(target).toEqual({
      source: "default-product",
      product: "ConST326",
      path: "/repo/apps/web/wikis/ConST326",
    });
  });

  it("falls back to the home folder when nothing at all is configured", () => {
    const target = selectWikiTarget(none(), { ...DEPS, defaultProduct: null });
    expect(target).toEqual({ source: "home-fallback", path: "/home/tester/llm-wiki-default" });
  });

  it("empty strings count as 'not set' rather than resolving to ''", () => {
    const target = selectWikiTarget(
      { headerProduct: "", envPath: "", activeWiki: "" } as unknown as WikiRoutingInput,
      DEPS,
    );
    expect(target.source).toBe("default-product");
  });
});

describe("selectWikiTarget product allow-list", () => {
  it("rejects an unknown product from the header", () => {
    expect(() =>
      selectWikiTarget({ headerProduct: "Const326", envPath: null, activeWiki: null }, DEPS),
    ).toThrow(WikiRoutingError);
  });

  it("rejects even when a valid default exists — never silently falls back", () => {
    // The previous failure mode was swallowing this into the default wiki,
    // which looked like "my wiki is empty" rather than a typo.
    expect(() =>
      selectWikiTarget({ headerProduct: "typo-name", envPath: null, activeWiki: null }, DEPS),
    ).toThrow(/Unknown wiki product "typo-name"/);
  });

  it("accepts anything when no allow-list is configured", () => {
    const permissive: WikiRoutingDeps = { ...DEPS, isKnownProduct: () => true };
    const target = selectWikiTarget({ headerProduct: "brand-new", envPath: null, activeWiki: null }, permissive);
    expect(target.path).toBe("/repo/apps/web/wikis/brand-new");
  });

  it("describeRoutingError names the known products for an actionable 400", () => {
    const err = new WikiRoutingError("boom", "Const326");
    const msg = describeRoutingError(err, () => ["ConST326", "ConST560"]);
    expect(msg).toContain("ConST560");
    expect(msg).toContain("llm-wiki.config.json");
  });
});
