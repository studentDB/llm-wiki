#!/usr/bin/env node
// LLM Wiki CLI — plain ESM, no compile step, no workspace dep imports.
// Self-contained on purpose: this script runs via `node` directly when the
// package is installed globally, so it can't rely on TS-source resolution.
// Spec: docs/09-cli-distribution.md

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(SELF_DIR, "..");

// ---- runtime config file (llm-wiki.config.json) ---------------------------
// Duplicated on purpose — this file must stay self-contained so it boots with
// plain `node` from a global install, without resolving TS workspace sources.
// Same discovery order as packages/llm/src/runtime-config.ts.

const CONFIG_FILENAME = "llm-wiki.config.json";

function findRuntimeConfigFile() {
  const explicit = process.env["LLM_WIKI_CONFIG"];
  if (explicit && existsSync(explicit)) return resolve(explicit);
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function loadRuntimeConfig() {
  const path = findRuntimeConfigFile();
  if (!path) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? { ...parsed, __path: path } : null;
  } catch (err) {
    console.warn(`warning: ignoring unreadable ${path}: ${err.message}`);
    return null;
  }
}

const RUNTIME_CONFIG = loadRuntimeConfig();

function resolveProductDir(product) {
  const cfg = RUNTIME_CONFIG;
  const baseDir = cfg?.wiki?.baseDir ?? process.env["LLM_WIKI_BASE_DIR"] ?? "wikis";
  const root = cfg?.__path ? dirname(cfg.__path) : process.cwd();
  return resolve(root, baseDir, product);
}

/** Minimal .env reader. The CLI spawns the server itself when running in dev,
 *  so Next's automatic .env.local loading doesn't apply — without this, keys
 *  placed in .env.local would never reach the child process. */
function loadDotEnv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  try {
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key) out[key] = value;
    }
  } catch {
    // Malformed dotenv — treat as empty rather than failing startup.
  }
  return out;
}

const DEFAULT_PORT = Number(
  process.env["LLM_WIKI_PORT"] ?? RUNTIME_CONFIG?.server?.port ?? 3737,
);

// ---- argv parsing --------------------------------------------------------

function parseArgs(argv) {
  const args = {
    _: [],
    flags: {
      port: null,
      open: true,
      quiet: false,
      debug: false,
      product: null,
      topic: null,
      template: null,
      activate: true,
    },
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") {
      args.flags.port = Number(argv[++i]);
    } else if (a === "--no-open") {
      args.flags.open = false;
    } else if (a === "--quiet") {
      args.flags.quiet = true;
    } else if (a === "--debug") {
      args.flags.debug = true;
    } else if (a === "--product") {
      args.flags.product = argv[++i];
    } else if (a === "--topic") {
      args.flags.topic = argv[++i];
    } else if (a === "--template") {
      args.flags.template = argv[++i];
    } else if (a === "--no-activate") {
      args.flags.activate = false;
    } else if (a.startsWith("--product=")) {
      args.flags.product = a.slice("--product=".length);
    } else if (a.startsWith("--topic=")) {
      args.flags.topic = a.slice("--topic=".length);
    } else if (a.startsWith("--template=")) {
      args.flags.template = a.slice("--template=".length);
    } else if (a.startsWith("--port=")) {
      args.flags.port = Number(a.slice("--port=".length));
    } else if (a === "--help" || a === "-h") {
      args._.unshift("help");
    } else if (a.startsWith("-")) {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    } else {
      args._.push(a);
    }
  }
  return args;
}

// ---- generic helpers -----------------------------------------------------

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readPackageVersion() {
  try {
    const raw = await readFile(join(PACKAGE_DIR, "package.json"), "utf8");
    return JSON.parse(raw).version;
  } catch {
    return "0.0.0";
  }
}

function isPortAvailable(port) {
  return new Promise((resolveFn) => {
    const srv = createServer();
    srv.once("error", () => resolveFn(false));
    srv.once("listening", () => srv.close(() => resolveFn(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function findAvailablePort(preferred, maxTries = 20) {
  let p = preferred;
  for (let i = 0; i < maxTries; i++) {
    if (await isPortAvailable(p)) return p;
    p++;
  }
  throw new Error(`no port available in range ${preferred}..${preferred + maxTries}`);
}

function resolveWikiPath(arg) {
  return arg ? resolve(arg) : process.cwd();
}

function globalConfigDir() {
  return process.env["LLM_WIKI_CONFIG_DIR"] ?? join(homedir(), ".llm-wiki");
}

function globalConfigPath() {
  return join(globalConfigDir(), "config.json");
}

function maskKey(key) {
  if (!key) return null;
  if (key.length <= 8) return "***";
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

// ---- inlined wiki init ---------------------------------------------------
// Kept in sync with packages/core/src/templates.ts. If those defaults change,
// this needs an update. Intentional duplication: keeps the CLI free of TS-
// source imports so it boots via plain `node` after npm install.

const WIKI_PATHS = {
  schema: "CLAUDE.md",
  index: "index.md",
  log: "log.md",
  gitignore: ".gitignore",
  wiki: "wiki",
  raw: "raw",
  chats: "chats",
  tooling: ".llm-wiki",
};

const DEFAULT_CHAT_FOLDERS = ["inbox", "pinned", "archive"];

const DEFAULT_SCHEMA = `# Wiki Schema

This file is your operating contract with the LLM agent that maintains this
wiki. Edit it freely to steer what gets written and how.

## Topic

(Describe the topic of this wiki in one or two sentences.)

## Style guidelines

- Be concise. This is a personal wiki, not Wikipedia.
- One entity or concept per page.
- Cross-link generously with \`[[slug]]\`.
- Flag contradictions in a \`> [!contradiction]\` callout.

## Page type definitions

- **entity**: a person, organization, product, place
- **concept**: an idea, technique, framework, theorem
- **source**: a single document summary (for important sources only)
- **comparison**: two or more entities/concepts contrasted
- **overview**: high-level synthesis
`;

const DEFAULT_INDEX = `# Wiki Index

_No pages yet. Add a source to get started._
`;

const DEFAULT_LOG = `# Wiki Log
`;

const DEFAULT_GITIGNORE = `# LLM Wiki tooling state (metadata cache, settings, trash, page history).
# Safe to delete; nothing important is lost.
.llm-wiki/
`;

async function writeIfMissing(path, content) {
  if (await fileExists(path)) return false;
  await writeFile(path, content, "utf8");
  return true;
}

async function initWikiFolder(wikiPath) {
  await mkdir(wikiPath, { recursive: true });
  const dirs = [
    join(wikiPath, WIKI_PATHS.wiki),
    join(wikiPath, WIKI_PATHS.raw),
    join(wikiPath, WIKI_PATHS.chats),
    join(wikiPath, WIKI_PATHS.tooling),
    ...DEFAULT_CHAT_FOLDERS.map((f) => join(wikiPath, WIKI_PATHS.chats, f)),
  ];
  await Promise.all(dirs.map((d) => mkdir(d, { recursive: true })));
  await writeIfMissing(join(wikiPath, WIKI_PATHS.schema), DEFAULT_SCHEMA);
  await writeIfMissing(join(wikiPath, WIKI_PATHS.index), DEFAULT_INDEX);
  await writeIfMissing(join(wikiPath, WIKI_PATHS.log), DEFAULT_LOG);
  await writeIfMissing(join(wikiPath, WIKI_PATHS.gitignore), DEFAULT_GITIGNORE);
}

// ---- inlined config (no keytar; reads file-fallback only) ----------------

async function loadGlobalConfig() {
  try {
    const raw = await readFile(globalConfigPath(), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch (err) {
    if (err.code === "ENOENT") return { version: 1, recentWikis: [], uiTheme: "auto" };
    throw err;
  }
}

async function saveGlobalConfig(cfg) {
  await mkdir(globalConfigDir(), { recursive: true });
  await writeFile(globalConfigPath(), `${JSON.stringify(cfg, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await chmod(globalConfigPath(), 0o600);
  } catch {
    // Windows ignores POSIX modes; ignore.
  }
}

async function addRecentWiki(wikiPath) {
  const cfg = await loadGlobalConfig();
  const recent = Array.isArray(cfg.recentWikis) ? cfg.recentWikis : [];
  const filtered = recent.filter((p) => p !== wikiPath);
  cfg.recentWikis = [wikiPath, ...filtered].slice(0, 10);
  await saveGlobalConfig(cfg);
}

// ---- commands ------------------------------------------------------------

async function cmdVersion() {
  console.log(await readPackageVersion());
}

function cmdHelp() {
  console.log(`llm-wiki <command> [options]

Commands:
  start [folder]          Start the wiki server (default command)
  init [folder]           Initialize a folder as a wiki without starting
  init --product <name>   Initialize <baseDir>/<name> from llm-wiki.config.json
  config                  Print the global config path
  config get <key>        Print a config value
  config set <key> <val>  Set a config value
  doctor                  Check installation and connectivity
  version                 Print version
  help                    Show this help

Options:
  --port <port>           Port to bind (default: config server.port, else 3737)
  --product <name>        Target product for init (path resolved via config baseDir)
  --topic <topic>         Seed topic to stamp into CLAUDE.md + settings.json
  --template <id>         Schema template hint (applied by /api/wikis/init)
  --no-activate           Don't make an initialized product the active wiki
  --no-open               Don't open the browser automatically
  --quiet                 Suppress non-error logs
  --debug                 Verbose logs

Configuration:
  Secrets go in .env.local (never committed):
    CUSTOM_OPENAI_API_KEY, ALIYUN_API_KEY, OPENROUTER_API_KEY
  Everything else goes in llm-wiki.config.json (committable):
    server.port, wiki.baseDir, wiki.defaultProduct, wiki.products,
    providers.*.baseUrl, defaults.models.*, ingestRouting, ui.language

Examples:
  llm-wiki start
  llm-wiki start ~/research/quantum --port 4000
  llm-wiki init ~/research/quantum
  llm-wiki init --product ConST326 --topic "ConST326 智能压力校验仪"
  llm-wiki doctor
`);
}

async function cmdInit(args) {
  // Two forms:
  //   llm-wiki init [folder]                       — init an explicit folder (classic)
  //   llm-wiki init --product <name> [--topic …]   — init by product name using
  //                                                  llm-wiki.config.json's baseDir
  // The product form is the unattended-deployment path: a script only needs to
  // know the product name, not where the repo happens to live.
  const product = args.flags.product || null;
  const wikiPath = product ? resolveProductDir(product) : resolveWikiPath(args._[1]);

  const topic =
    args.flags.topic ||
    (product && RUNTIME_CONFIG?.wiki?.products?.[product]?.topic) ||
    null;
  const template =
    args.flags.template ||
    (product && RUNTIME_CONFIG?.wiki?.products?.[product]?.template) ||
    null;

  if (!args.flags.quiet) {
    console.log(`Initializing wiki at ${wikiPath}`);
  }
  await initWikiFolder(wikiPath);

  if (topic) {
    await stampTopic(wikiPath, topic);
  }
  if (template && template !== "blank") {
    console.warn(
      `note: template "${template}" is applied by POST /api/wikis/init at runtime; the CLI only seeds the folder structure here.`,
    );
  }

  if (!args.flags.quiet) {
    console.log(`✓ created: CLAUDE.md, index.md, log.md, .gitignore`);
    console.log(
      `✓ created: ${WIKI_PATHS.wiki}/, ${WIKI_PATHS.raw}/, ${WIKI_PATHS.chats}/{inbox,pinned,archive}/, ${WIKI_PATHS.tooling}/`,
    );
    if (topic) console.log(`✓ topic: ${topic}`);
    console.log(
      `Next: ${product ? `llm-wiki start` : `llm-wiki start ${wikiPath}`}`.trim(),
    );
  }
}

/**
 * Writes the topic into both places the app reads it from: the `## Topic`
 * section of CLAUDE.md (which is what actually steers the ingest LLM) and
 * `.llm-wiki/settings.json` (which is what the requireSetup gate checks).
 */
async function stampTopic(wikiPath, topic) {
  const schemaPath = join(wikiPath, WIKI_PATHS.schema);
  try {
    const raw = await readFile(schemaPath, "utf8");
    const stamped = raw.replace(/## Topic\n\n\([^)]*\)/, `## Topic\n\n${topic}`);
    await writeFile(schemaPath, stamped, "utf8");
  } catch {
    // Missing CLAUDE.md shouldn't abort init — the settings stamp below still lands.
  }
  const settingsPath = join(wikiPath, WIKI_PATHS.tooling, "settings.json");
  let existing = {};
  try {
    existing = JSON.parse(await readFile(settingsPath, "utf8"));
  } catch {
    existing = {};
  }
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(
    settingsPath,
    `${JSON.stringify({ version: 1, topic: "", ...existing, topic }, null, 2)}\n`,
    "utf8",
  );
}

async function cmdConfig(args) {
  const sub = args._[1];
  if (!sub) {
    console.log(globalConfigPath());
    return;
  }
  if (sub === "get") {
    const key = args._[2];
    if (!key) {
      console.error("usage: llm-wiki config get <key>");
      process.exit(2);
    }
    const cfg = await loadGlobalConfig();
    const value = cfg[key];
    if (key === "openrouterKey") {
      console.log(value ? maskKey(value) : "(not set)");
    } else {
      console.log(value === undefined ? "(not set)" : JSON.stringify(value));
    }
    return;
  }
  if (sub === "set") {
    const key = args._[2];
    const val = args._[3];
    if (!key || val === undefined) {
      console.error("usage: llm-wiki config set <key> <value>");
      process.exit(2);
    }
    const cfg = await loadGlobalConfig();
    cfg[key] = val;
    await saveGlobalConfig(cfg);
    console.log(`set ${key}`);
    return;
  }
  console.error(`unknown config subcommand: ${sub}`);
  process.exit(2);
}

async function cmdDoctor() {
  const version = await readPackageVersion();
  let allOk = true;

  console.log("Checking installation...");
  console.log(`  ✓ llm-wiki version: ${version}`);
  console.log(`  ✓ Node version: ${process.version}`);
  console.log(`  ✓ Platform: ${process.platform} ${process.arch}`);

  console.log("");
  console.log("Checking config...");
  console.log(`  ✓ Config dir: ${globalConfigDir()}`);

  let cfg;
  try {
    cfg = await loadGlobalConfig();
  } catch (err) {
    console.log(`  ✗ Could not load config: ${err.message}`);
    allOk = false;
    cfg = {};
  }

  // We can only see the file-fallback key from this side. The doctor command
  // can't probe the OS keychain without running the app's runtime — the user
  // should use the Settings page in the browser for that.
  const keyFromConfig = cfg.openrouterKey;
  if (keyFromConfig) {
    console.log(
      `  ✓ OpenRouter API key set in config file (${maskKey(keyFromConfig)})`,
    );
  } else {
    console.log(
      `  · OpenRouter API key NOT set in config file — may be in OS keychain (set via the Settings page after 'llm-wiki start')`,
    );
  }

  console.log("");
  console.log("Checking runtime config...");
  if (RUNTIME_CONFIG) {
    console.log(`  ✓ llm-wiki.config.json: ${RUNTIME_CONFIG.__path}`);
    const products = Object.keys(RUNTIME_CONFIG.wiki?.products ?? {});
    const def = RUNTIME_CONFIG.wiki?.defaultProduct ?? null;
    console.log(
      def
        ? `  ✓ wiki.defaultProduct: ${def}`
        : `  · wiki.defaultProduct: (not set — falls back to ~/.llm-wiki/config.json activeWiki)`,
    );
    console.log(
      products.length > 0
        ? `  ✓ known products: ${products.join(", ")}`
        : `  · no wiki.products declared — product allow-list guard is off`,
    );
    const missing = [];
    for (const p of ["ingest", "query", "chat", "lint", "vision"]) {
      if (!RUNTIME_CONFIG.defaults?.models?.[p]?.model) missing.push(p);
    }
    console.log(
      missing.length === 0
        ? `  ✓ all 5 model slots configured`
        : `  · model slots missing from config: ${missing.join(", ")} (built-in defaults apply)`,
    );
  } else {
    console.log(`  · no llm-wiki.config.json found — using built-in defaults`);
  }

  // Secrets live in .env.local, loaded by Next or by this CLI's start command.
  const dotenv = loadDotEnv(join(PACKAGE_DIR, ".env.local"));
  const secretKeys = ["CUSTOM_OPENAI_API_KEY", "ALIYUN_API_KEY", "OPENROUTER_API_KEY"];
  const present = secretKeys.filter((k) => (dotenv[k] || process.env[k]));
  console.log("");
  console.log("Checking secrets...");
  if (present.length > 0) {
    console.log(`  ✓ keys present: ${present.join(", ")}`);
  } else {
    console.log(
      `  ✗ no provider keys found. Create apps/web/.env.local (see .env.example).`,
    );
    allOk = false;
  }

  if (keyFromConfig) {
    console.log("");
    console.log("Checking OpenRouter connectivity...");
    try {
      const res = await fetch("https://openrouter.ai/api/v1/key", {
        headers: { Authorization: `Bearer ${keyFromConfig}` },
      });
      if (res.ok) {
        const body = await res.json();
        console.log(`  ✓ Reachable`);
        console.log(`  ✓ API key valid (account: ${body.data?.label ?? "?"})`);
      } else if (res.status === 401 || res.status === 403) {
        console.log(`  ✗ API key rejected by OpenRouter (HTTP ${res.status})`);
        allOk = false;
      } else {
        console.log(`  · OpenRouter returned HTTP ${res.status}`);
      }
    } catch (err) {
      console.log(`  ✗ Could not reach OpenRouter: ${err.message}`);
      allOk = false;
    }
  }

  if (cfg.recentWikis && cfg.recentWikis.length > 0) {
    console.log("");
    console.log("Recent wikis:");
    for (const p of cfg.recentWikis.slice(0, 5)) console.log(`  · ${p}`);
  }

  console.log("");
  console.log(allOk ? "All checks passed. ✓" : "Some checks failed. ✗");
  process.exit(allOk ? 0 : 1);
}

async function cmdStart(args) {
  // Only pin LLM_WIKI_PATH when the user named a folder explicitly. Leaving it
  // unset lets the server fall through to `wiki.defaultProduct` in
  // llm-wiki.config.json — which is the whole point of the config file.
  const explicitFolder = args._[1] ? resolveWikiPath(args._[1]) : null;
  const wikiPath =
    explicitFolder ??
    (RUNTIME_CONFIG?.wiki?.defaultProduct
      ? resolveProductDir(RUNTIME_CONFIG.wiki.defaultProduct)
      : null) ??
    process.cwd();

  const toolingDir = join(wikiPath, WIKI_PATHS.tooling);
  if (!(await fileExists(toolingDir))) {
    if (!args.flags.quiet) {
      console.log(`Initializing wiki at ${wikiPath}...`);
    }
    await initWikiFolder(wikiPath);
  }

  await addRecentWiki(wikiPath).catch(() => {});

  const preferred = args.flags.port ?? DEFAULT_PORT;
  const port = await findAvailablePort(preferred);
  if (port !== preferred && !args.flags.quiet) {
    console.log(`Port ${preferred} busy; using ${port}`);
  }

  // Bind address. Read from LLM_WIKI_HOST -> llm-wiki.config.json
  // (server.host) -> loopback.
  //
  // Deliberately NOT reusing process.env.HOSTNAME: every container runtime
  // (Docker, Kubernetes, most PaaS) injects HOSTNAME=<container id>, and Next
  // falls back to process.env.HOSTNAME for its bind address. Passing that
  // through makes the server try to bind to a hostname that doesn't resolve,
  // which reads as a startup crash rather than an obvious config mistake.
  // We overwrite HOSTNAME with the resolved bind address so both the CLI's
  // -H flag and Next's env fallback agree.
  const bindHost =
    process.env["LLM_WIKI_HOST"] ?? RUNTIME_CONFIG?.server?.host ?? "127.0.0.1";

  // Production install: prefer the standalone server bundle.
  // Workspace dev: fall back to `next dev` from local node_modules.
  const standaloneServer = join(PACKAGE_DIR, ".next", "standalone", "apps", "web", "server.js");
  let cmd, cmdArgs, mode;
  if (await fileExists(standaloneServer)) {
    cmd = process.execPath; // node
    cmdArgs = [standaloneServer];
    mode = "standalone";
  } else {
    cmd = process.execPath;
    cmdArgs = [
      join(PACKAGE_DIR, "node_modules", "next", "dist", "bin", "next"),
      "dev",
      "-p",
      String(port),
      "-H",
      bindHost,
    ];
    mode = "dev";
  }

  if (!args.flags.quiet) {
    console.log(`Starting LLM Wiki (${mode}) on http://localhost:${port}`);
    console.log(`Wiki: ${wikiPath}`);
  }

  // Update banner. Runs before spawn so the message lands above the Next
  // server logs that take over stdio. Reads cache only — no network on the
  // hot path. Stale cache triggers a background refresh for next time.
  await maybePrintUpdateBanner(await readPackageVersion(), args.flags.quiet);

  const env = {
    ...process.env,
    // Load .env.local ourselves. Next does this automatically for `next dev`,
    // but this CLI spawns that process for global installs, and previously any
    // key living in .env.local never reached the server.
    ...loadDotEnv(join(PACKAGE_DIR, ".env.local")),
    PORT: String(port),
    HOSTNAME: bindHost,
    LLM_WIKI_HOST: bindHost,
  };
  // Only override when explicitly requested — see comment above.
  if (explicitFolder) env.LLM_WIKI_PATH = wikiPath;
  if (process.env["LLM_WIKI_PRODUCT"]) env.LLM_WIKI_PRODUCT = process.env["LLM_WIKI_PRODUCT"];

  const child = spawn(cmd, cmdArgs, { cwd: PACKAGE_DIR, env, stdio: "inherit" });

  if (args.flags.open) {
    setTimeout(async () => {
      try {
        const open = (await import("open")).default;
        await open(`http://localhost:${port}`);
      } catch {
        // best-effort
      }
    }, 2000);
  }

  const shutdown = (signal) => child.kill(signal);
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  child.on("exit", (code) => process.exit(code ?? 0));
}

// ---- update check --------------------------------------------------------
// Cached on disk in ~/.llm-wiki/update-check.json. The cached "latest" string
// drives the banner; we refresh in the background so the user never waits on
// the registry. Net effect: first run after an upgrade is published is
// silent; the banner appears on the *next* start. Matches the
// `update-notifier` library's behavior and avoids slowing startup.

const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const NPM_REGISTRY_LATEST = "https://registry.npmjs.org/@syasas/llm-wiki/latest";

function updateCheckPath() {
  return join(globalConfigDir(), "update-check.json");
}

// Loose semver compare — returns true if `a` > `b`. Handles "1.2.10" > "1.2.9"
// correctly (numeric, not string). Prerelease tags (-beta, -rc) drop to a
// lower-than-equal precedence so we never nag stable users to install a beta.
function semverGt(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).split("-");
    const parts = core.split(".").map((n) => Number.parseInt(n, 10));
    return { parts, isPre: Boolean(pre) };
  };
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < 3; i++) {
    const ai = A.parts[i] ?? 0;
    const bi = B.parts[i] ?? 0;
    if (Number.isNaN(ai) || Number.isNaN(bi)) return false;
    if (ai !== bi) return ai > bi;
  }
  if (A.isPre !== B.isPre) return !A.isPre;
  return false;
}

async function readUpdateCache() {
  try {
    const raw = await readFile(updateCheckPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.latest === "string" && typeof parsed?.lastCheck === "number") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeUpdateCache(latest) {
  try {
    await mkdir(globalConfigDir(), { recursive: true });
    await writeFile(
      updateCheckPath(),
      `${JSON.stringify({ lastCheck: Date.now(), latest }, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // Cache is opportunistic — silent failures are fine.
  }
}

async function refreshUpdateCache() {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(NPM_REGISTRY_LATEST, { signal: ctrl.signal });
    clearTimeout(timeout);
    if (!res.ok) return;
    const body = await res.json();
    if (typeof body?.version === "string") {
      await writeUpdateCache(body.version);
    }
  } catch {
    // Offline, registry down, slow — silent. Try again next run.
  }
}

async function maybePrintUpdateBanner(current, quiet) {
  if (quiet) return;
  if (process.env["NO_UPDATE_NOTIFIER"] === "1") return;
  const cache = await readUpdateCache();
  const stale = !cache || Date.now() - cache.lastCheck > UPDATE_CHECK_TTL_MS;
  // Kick off a refresh if stale. Fire-and-forget — next start surfaces it.
  if (stale) void refreshUpdateCache();
  if (!cache?.latest) return;
  if (!semverGt(cache.latest, current)) return;
  // 36 = inside-width of the box. Mirrors the first-run banner's box style.
  const innerWidth = 51;
  const headline = `  Update available: ${current} → ${cache.latest}`;
  const cmd = `  Run: npm install -g @syasas/llm-wiki@latest`;
  const top = "─".repeat(innerWidth);
  const pad = (s) => s + " ".repeat(Math.max(0, innerWidth - s.length));
  process.stdout.write(
    `\n\x1b[33m╭${top}╮\x1b[0m\n` +
      `\x1b[33m│\x1b[0m\x1b[1m${pad(headline)}\x1b[0m\x1b[33m│\x1b[0m\n` +
      `\x1b[33m│\x1b[0m${pad(cmd)}\x1b[33m│\x1b[0m\n` +
      `\x1b[33m╰${top}╯\x1b[0m\n\n`,
  );
}

// ---- first-run banner ----------------------------------------------------

// Detects whether the global config exists (created lazily by `start` /
// the wizard). Used to decide if this is the user's first time touching
// the CLI. Returns true only if `~/.llm-wiki/config.json` is missing.
async function isFirstRunEver() {
  try {
    await access(globalConfigPath());
    return false;
  } catch {
    return true;
  }
}

async function printFirstRunBanner() {
  const version = await readPackageVersion();
  // 49 = inside-width of the box (columns between the two │ characters).
  // Padding is computed from VISIBLE text width — the ANSI escapes inside
  // the box contribute zero columns to the terminal but were previously
  // counted by hand, which drifted whenever the version string changed.
  const innerWidth = 49;
  const title = `  Welcome to LLM Wiki v${version}`;
  const pad = " ".repeat(Math.max(0, innerWidth - title.length));
  const top = "─".repeat(innerWidth);
  const banner = `
\x1b[36m╭${top}╮\x1b[0m
\x1b[36m│\x1b[0m  \x1b[1mWelcome to LLM Wiki\x1b[0m v${version}${pad}\x1b[36m│\x1b[0m
\x1b[36m╰${top}╯\x1b[0m

  Looks like this is your first time. Three commands to know:

    \x1b[1mllm-wiki doctor\x1b[0m    Verify install + check for an API key
    \x1b[1mllm-wiki start\x1b[0m     Boot the server (auto-opens browser)
    \x1b[1mllm-wiki help\x1b[0m      Full command + flag list

  You'll need an OpenRouter API key — get one at
  \x1b[34mhttps://openrouter.ai/keys\x1b[0m (pay-as-you-go, ~$5 lasts weeks).

`;
  process.stdout.write(banner);
}

// ---- dispatch ------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Lowercase the command so `Doctor` / `DOCTOR` / `doctor` all dispatch the
  // same. Common case-mismatch on Windows where the filesystem itself is
  // case-insensitive and users naturally capitalize. Also normalize the
  // first config sub-command (`get` / `set`) for the same reason — that
  // walk happens inside cmdConfig() which reads args._[1] directly, so we
  // patch it here at the source.
  const cmd = (args._[0] ?? "start").toLowerCase();
  args._[0] = cmd;
  if (cmd === "config" && typeof args._[1] === "string") {
    args._[1] = args._[1].toLowerCase();
  }

  // First-run welcome — only on the very first invocation, only if not
  // silenced by --quiet, and skip for `version` / `help` which don't
  // need a friendly banner glued to their output.
  if (
    !args.flags.quiet &&
    cmd !== "version" &&
    cmd !== "--version" &&
    cmd !== "-v" &&
    cmd !== "help"
  ) {
    if (await isFirstRunEver()) {
      await printFirstRunBanner();
    }
  }

  try {
    switch (cmd) {
      case "start":
        return await cmdStart(args);
      case "init":
        return await cmdInit(args);
      case "config":
        return await cmdConfig(args);
      case "doctor":
        return await cmdDoctor();
      case "version":
      case "--version":
      case "-v":
        return await cmdVersion();
      case "help":
        return cmdHelp();
      default:
        console.error(`unknown command: ${cmd}`);
        cmdHelp();
        process.exit(2);
    }
  } catch (err) {
    console.error(`error: ${err.message ?? err}`);
    if (args.flags.debug) console.error(err.stack);
    process.exit(1);
  }
}

main();
