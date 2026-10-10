// Runtime configuration: a repo-level, committable config file
// (`llm-wiki.config.json`) that replaces the old habit of pasting provider
// endpoints / API keys / wiki paths into the terminal before launching.
//
// Resolution order for every value (highest wins):
//   1. environment variable (CI, one-off overrides)
//   2. llm-wiki.config.json (committable, ships with the deployment artifact)
//   3. built-in defaults below
//
// Why this lives in @llm-wiki/llm and not @llm-wiki/core: the dependency
// graph is one-directional (core -> llm), so putting shared runtime config
// any higher would create a cycle. Web + core import it through core's
// re-export.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type ProviderName = "openrouter" | "ollama" | "custom" | "aliyun";

export const PROVIDER_NAMES: ProviderName[] = ["openrouter", "ollama", "custom", "aliyun"];

export type ModelSlotName = "ingest" | "query" | "chat" | "lint" | "vision";

export const MODEL_SLOT_NAMES: ModelSlotName[] = ["ingest", "query", "chat", "lint", "vision"];

/** Ingest input formats we know how to route to a model slot. */
export type RoutableFormat =
  | "pdf"
  | "image"
  | "docx"
  | "xlsx"
  | "pptx"
  | "html"
  | "md"
  | "txt"
  | "url";

export type ModelSlotConfig = {
  provider: ProviderName;
  model: string;
};

export type UiLanguage = "zh-CN" | "en";
export type RuntimeUiTheme = "light" | "dark" | "auto";

export type WikiProductConfig = {
  /** Seed topic used when a wiki for this product is created fresh. */
  topic?: string;
  /** CLAUDE.md template id to stamp on creation (e.g. "zh-hardware"). */
  template?: string;
};

export type RuntimeServerConfig = {
  port: number;
  host: string;
  /** Echo the assembled Query prompt to stdout. Was LLM_WIKI_LOG_QUERY_PROMPT. */
  logQueryPrompt: boolean;
};

export type RuntimeWikiConfig = {
  /** Directory holding per-product wiki folders. Relative to config file dir. */
  baseDir: string;
  /** Which product to point at when nothing else (header/env/activeWiki) says. */
  defaultProduct: string | null;
  /** Known products. Doubles as an allow-list guarding against typo-created
   *  empty wikis. Empty/undefined means "no allow-list" (dev convenience). */
  products: Record<string, WikiProductConfig>;
};

export type RuntimeUiConfig = {
  language: UiLanguage;
  theme: RuntimeUiTheme;
};

export type RuntimeConfig = {
  version: number;
  server: RuntimeServerConfig;
  wiki: RuntimeWikiConfig;
  providers: Record<ProviderName, { baseUrl: string | null }>;
  defaults: {
    models: Record<ModelSlotName, ModelSlotConfig>;
    autoLintAfterIngest: boolean;
    showCostEstimates: boolean;
    requireApprovalForIngest: boolean;
  };
  /** input format -> model slot. Anything absent falls back to kind-based routing. */
  ingestRouting: Partial<Record<RoutableFormat, "vision" | "ingest">>;
  ui: RuntimeUiConfig;
  /** Absolute path the file was loaded from, or null when using pure defaults. */
  source: string | null;
};

// ---- built-in defaults (lowest priority) -----------------------------------
//
// These mirror what used to be hard-coded in core's DEFAULT_WIKI_SETTINGS and
// llm/client.ts's process.env fallbacks.

function builtInDefaults(): RuntimeConfig {
  return {
    version: 1,
    server: {
      port: 3737,
      host: "127.0.0.1",
      logQueryPrompt: false,
    },
    wiki: {
      baseDir: "wikis",
      defaultProduct: null,
      products: {},
    },
    providers: {
      openrouter: { baseUrl: "https://openrouter.ai/api/v1" },
      ollama: { baseUrl: "http://localhost:11434" },
      custom: { baseUrl: null },
      aliyun: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    },
    defaults: {
      models: {
        ingest: { provider: "custom", model: "DeepSeek-V4-Flash-0731" },
        query: { provider: "aliyun", model: "qwen-plus" },
        chat: { provider: "aliyun", model: "qwen-plus" },
        lint: { provider: "aliyun", model: "qwen-plus" },
        vision: { provider: "aliyun", model: "qwen3-vl-plus" },
      },
      autoLintAfterIngest: false,
      showCostEstimates: true,
      requireApprovalForIngest: false,
    },
    ingestRouting: {
      pdf: "vision",
      image: "vision",
      docx: "ingest",
      xlsx: "ingest",
      pptx: "ingest",
      html: "ingest",
      md: "ingest",
      txt: "ingest",
      url: "ingest",
    },
    ui: {
      language: "zh-CN",
      theme: "auto",
    },
    source: null,
  };
}

// ---- file discovery --------------------------------------------------------

const CONFIG_FILENAME = "llm-wiki.config.json";

export function runtimeConfigFilePath(): string | null {
  const explicit = process.env["LLM_WIKI_CONFIG"];
  if (explicit && existsSync(explicit)) return resolve(explicit);

  let dir = process.cwd();
  // Walk up so launching from apps/web finds a config placed at repo root.
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ---- parsing helpers -------------------------------------------------------

type Json = Record<string, unknown>;

function asRecord(v: unknown): Json | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function asInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback;
}

function envStr(name: string): string | null {
  const v = process.env[name];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function envBool(name: string): boolean | null {
  const v = process.env[name];
  if (v === undefined || v === "") return null;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

function deepMerge(base: RuntimeConfig, raw: Json): RuntimeConfig {
  const out: RuntimeConfig = {
    ...base,
    providers: { ...base.providers },
    defaults: { ...base.defaults, models: { ...base.defaults.models } },
    ingestRouting: { ...base.ingestRouting },
    wiki: { ...base.wiki, products: { ...base.wiki.products } },
  };

  // server
  const server = asRecord(raw["server"]);
  if (server) {
    out.server = {
      port: asInt(server["port"], base.server.port),
      host: asString(server["host"]) ?? base.server.host,
      logQueryPrompt: asBool(server["logQueryPrompt"], base.server.logQueryPrompt),
    };
  }

  // wiki
  const wiki = asRecord(raw["wiki"]);
  if (wiki) {
    out.wiki = {
      baseDir: asString(wiki["baseDir"]) ?? base.wiki.baseDir,
      defaultProduct: asString(wiki["defaultProduct"]) ?? base.wiki.defaultProduct,
      products: { ...base.wiki.products },
    };
    const products = asRecord(wiki["products"]);
    if (products) {
      for (const [name, value] of Object.entries(products)) {
        const entry = asRecord(value) ?? {};
        out.wiki.products[name] = {
          topic: asString(entry["topic"]) ?? undefined,
          template: asString(entry["template"]) ?? undefined,
        };
      }
    }
  }

  // providers
  const providers = asRecord(raw["providers"]);
  if (providers) {
    for (const name of PROVIDER_NAMES) {
      const entry = asRecord(providers[name]);
      if (!entry) continue;
      out.providers[name] = {
        baseUrl: asString(entry["baseUrl"]) ?? base.providers[name].baseUrl,
      };
    }
  }

  // defaults.models + flags
  const defaults = asRecord(raw["defaults"]);
  if (defaults) {
    out.defaults = {
      models: { ...base.defaults.models },
      autoLintAfterIngest: asBool(defaults["autoLintAfterIngest"], base.defaults.autoLintAfterIngest),
      showCostEstimates: asBool(defaults["showCostEstimates"], base.defaults.showCostEstimates),
      requireApprovalForIngest: asBool(
        defaults["requireApprovalForIngest"],
        base.defaults.requireApprovalForIngest,
      ),
    };
    const models = asRecord(defaults["models"]);
    if (models) {
      for (const slot of MODEL_SLOT_NAMES) {
        const entry = asRecord(models[slot]);
        if (!entry) continue;
        const rawProvider = asString(entry["provider"]);
        const provider: ProviderName | null =
          rawProvider && PROVIDER_NAMES.includes(rawProvider as ProviderName)
            ? (rawProvider as ProviderName)
            : null;
        const model = asString(entry["model"]);
        out.defaults.models[slot] = {
          provider: provider ?? base.defaults.models[slot].provider,
          model: model ?? base.defaults.models[slot].model,
        };
      }
    }
  }

  // ingestRouting
  const routing = asRecord(raw["ingestRouting"]);
  if (routing) {
    for (const [format, slot] of Object.entries(routing)) {
      if (slot === "vision" || slot === "ingest") {
        out.ingestRouting[format as RoutableFormat] = slot;
      }
    }
  }

  // ui
  const ui = asRecord(raw["ui"]);
  if (ui) {
    const lang = asString(ui["language"]);
    const theme = asString(ui["theme"]);
    out.ui = {
      language: lang === "en" || lang === "zh-CN" ? lang : base.ui.language,
      theme:
        theme === "light" || theme === "dark" || theme === "auto" ? theme : base.ui.theme,
    };
  }

  return out;
}

function applyEnvOverrides(base: RuntimeConfig): RuntimeConfig {
  const out: RuntimeConfig = {
    ...base,
    providers: { ...base.providers },
    defaults: { ...base.defaults, models: { ...base.defaults.models } },
  };

  const customBase = envStr("CUSTOM_OPENAI_BASE_URL");
  if (customBase) out.providers.custom = { baseUrl: customBase };
  const aliyunBase = envStr("ALIYUN_BASE_URL");
  if (aliyunBase) out.providers.aliyun = { baseUrl: aliyunBase };
  const ollamaBase = envStr("OLLAMA_BASE_URL");
  if (ollamaBase) out.providers.ollama = { baseUrl: ollamaBase };
  const openrouterBase = envStr("OPENROUTER_BASE_URL");
  if (openrouterBase) out.providers.openrouter = { baseUrl: openrouterBase };

  const port = envStr("PORT") ?? envStr("LLM_WIKI_PORT");
  if (port && Number.isFinite(Number(port))) out.server = { ...out.server, port: Number(port) };
  const host = envStr("HOST") ?? envStr("LLM_WIKI_HOST");
  if (host) out.server = { ...out.server, host };

  const logQuery = envBool("LLM_WIKI_LOG_QUERY_PROMPT");
  if (logQuery !== null) out.server = { ...out.server, logQueryPrompt: logQuery };

  const product = envStr("LLM_WIKI_PRODUCT");
  if (product) out.wiki = { ...out.wiki, defaultProduct: product };
  const baseDir = envStr("LLM_WIKI_BASE_DIR");
  if (baseDir) out.wiki = { ...out.wiki, baseDir };

  const ingestModel = envStr("LLM_WIKI_MODEL_INGEST");
  if (ingestModel) {
    out.defaults.models.ingest = { ...out.defaults.models.ingest, model: ingestModel };
  }
  const visionModel = envStr("LLM_WIKI_MODEL_VISION");
  if (visionModel) {
    out.defaults.models.vision = { ...out.defaults.models.vision, model: visionModel };
  }

  return out;
}

// ---- public API ------------------------------------------------------------

let cache: RuntimeConfig | null = null;

/**
 * Synchronous load — deliberately sync because it runs inside Next.js server
 * component render paths (see core's resolveWikiPath precedent). The file is
 * tiny and OS-cached, and the result is memoized for the process lifetime.
 */
export function getRuntimeConfig(): RuntimeConfig {
  if (cache) return cache;
  const path = runtimeConfigFilePath();
  let merged = builtInDefaults();
  if (path) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      const raw = asRecord(parsed);
      if (raw) merged = deepMerge(merged, raw);
      merged.source = path;
    } catch (err) {
      // Malformed config must not brick the app — fall back to defaults and
      // make the reason loud.
      console.warn(
        `[runtime-config] ignoring unreadable config at ${path}: ${(err as Error).message}`,
      );
    }
  }
  cache = applyEnvOverrides(merged);
  return cache;
}

/** Directory the config file lives in — used to resolve relative `baseDir`. */
export function runtimeRootDir(): string {
  const src = getRuntimeConfig().source;
  return src ? dirname(src) : process.cwd();
}

/**
 * Absolute path of the per-product wiki directory for `product`, resolved
 * against the config file's directory (so relative `baseDir` stays portable).
 */
export function resolveProductWikiDir(product: string): string {
  const cfg = getRuntimeConfig();
  const base = cfg.wiki.baseDir;
  return resolve(runtimeRootDir(), base, product);
}

/** Topic seed for a product, or null when the product is unknown to config. */
export function productTopic(product: string): string | null {
  return getRuntimeConfig().wiki.products[product]?.topic ?? null;
}

/** Template id to stamp on creation for a product, or null. */
export function productTemplate(product: string): string | null {
  return getRuntimeConfig().wiki.products[product]?.template ?? null;
}

/**
 * Known products. Returns null when the allow-list is empty, meaning "don't
 * guard" (otherwise a fresh checkout with no config could never create a wiki).
 */
export function knownProducts(): string[] | null {
  const names = Object.keys(getRuntimeConfig().wiki.products);
  return names.length > 0 ? names : null;
}

export function isKnownProduct(product: string): boolean {
  const known = knownProducts();
  return known === null || known.includes(product);
}

/** Resolved base URL for a provider, or null when unset (e.g. custom without url). */
export function providerBaseUrl(provider: ProviderName): string | null {
  return getRuntimeConfig().providers[provider].baseUrl;
}

export function defaultModelSlot(slot: ModelSlotName): ModelSlotConfig {
  return getRuntimeConfig().defaults.models[slot];
}

/** input format -> "vision" | "ingest". Falls back to `fallback` when unmapped. */
export function ingestRouteFor(format: string, fallback: "vision" | "ingest"): "vision" | "ingest" {
  const cfg = getRuntimeConfig();
  const hit = (cfg.ingestRouting as Record<string, "vision" | "ingest" | undefined>)[format];
  return hit ?? fallback;
}

/** Test hook — drop the process-level cache so the next read re-parses. */
export function resetRuntimeConfigCache(): void {
  cache = null;
}
