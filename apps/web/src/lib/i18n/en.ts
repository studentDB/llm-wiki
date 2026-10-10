import type { MessageKey } from "./zh-CN";
import type { Messages } from "./types";

/**
 * `Record<MessageKey, string>` is the parity guarantee: add a key to zh-CN.ts
 * without translating it here and `pnpm typecheck` fails.
 */
export const en: Record<MessageKey, string> = {
  // ---- common ----
  "common.appName": "LLM Wiki",
  "common.home": "Home",
  "common.save": "Save",
  "common.cancel": "Cancel",
  "common.delete": "Delete",
  "common.edit": "Edit",
  "common.retry": "Retry",
  "common.close": "Close",
  "common.search": "Search",
  "common.loading": "Loading…",
  "common.empty": "Nothing here",
  "common.error": "Something went wrong",
  "common.optional": "optional",
  "common.required": "required",

  // ---- navigation ----
  "nav.wiki": "Wiki",
  "nav.graph": "Graph",
  "nav.sources": "Sources",
  "nav.query": "Query",
  "nav.chats": "Chats",
  "nav.lint": "Lint",
  "nav.schema": "Schema",
  "nav.settings": "Settings",
  "nav.manageWikis": "Manage wikis →",
  "nav.openMenu": "Open menu",

  // ---- wiki ----
  "wiki.title": "Pages",
  "wiki.index": "Wiki index",
  "wiki.searchPlaceholder": "Filter pages…",
  "wiki.empty.title": "No pages yet",
  "wiki.empty.body": "Upload a source or paste text and the LLM will draft pages for you.",
  "wiki.backlinks": "Backlinks",
  "wiki.history": "History",
  "wiki.deletePage": "Delete page",
  "wiki.restorePage": "Restore page",

  // ---- sources ----
  "sources.title": "Sources",
  "sources.upload": "Upload source",
  "sources.dropHint":
    "Drop a file or click to pick one (PDF / Word / Excel / PPT / web page / text)",
  "sources.empty.title": "No sources yet",
  "sources.empty.body": "Upload a document and its content will be extracted into pages.",
  "sources.status.pending": "Pending",
  "sources.status.ingested": "Ingested",
  "sources.status.failed": "Failed",
  "sources.reingest": "Re-ingest",
  "sources.ingestedList": "Ingested sources",
  "sources.titleField": "Title",
  "sources.originalsHint": "Originals live in",
  "sources.dropHere": "Drag a file here, or",
  "sources.chooseOne": "choose one",
  "sources.titlePlaceholder":
    "Defaults: first line for paste, page title for URL, filename for file",
  "sources.pastePlaceholder": "Paste an article, paper, or notes here...",
  "sources.ingest": "Ingest",
  "sources.ingesting": "Ingesting…",
  "sources.hintVision": "Vision call — uses the model from Settings → Models → vision.",
  "sources.hintText": "Text call — uses the ingest model. ~10–30s for typical sources.",
  "sources.headDescription":
    "Pasted text and Markdown go straight in. URLs fetch + extract via Readability. PDFs and images go through a vision model. DOCX/PPTX/XLSX get pre-parsed locally.",

  // ---- query ----
  "query.title": "Query",
  "query.placeholder": "Ask this knowledge base anything…",
  "query.example": "e.g. How does Shor's algorithm relate to RSA?",
  "query.ask": "Ask",
  "query.asking": "Asking…",
  "query.thinking": "Retrieving and answering…",
  "query.headDescription":
    "Ask the wiki and get a cited answer. Useful for one-shot lookups; for ongoing back-and-forth use Chats.",

  // ---- chats ----
  "chats.title": "Chats",
  "chats.new": "New chat",
  "chats.empty.title": "No chats yet",
  "chats.inputPlaceholder": "Type a message…",

  // ---- lint ----
  "lint.title": "Lint",
  "lint.run": "Run lint",
  "lint.running": "Linting…",
  "lint.noIssues": "No issues found",
  "lint.issues": "{count} issues found",

  // ---- dashboard ----
  "dashboard.title": "Dashboard",
  "dashboard.pages": "Pages",
  "dashboard.sources": "Sources",
  "dashboard.cost": "Total cost",

  // ---- settings ----
  "settings.title": "Settings",
  "settings.tabs.general": "General",
  "settings.tabs.models": "Models",
  "settings.tabs.api": "API Keys",
  "settings.tabs.costs": "Costs",
  "settings.tabs.wikis": "Wikis",
  "settings.tabs.about": "About",
  "settings.general.topic": "Wiki topic",
  "settings.general.topicHint":
    "Describes this wiki's scope. Leaving it blank brings the setup wizard back.",
  "settings.general.autoLint": "Auto-lint after ingest",
  "settings.general.showCosts": "Show cost estimates",
  "settings.general.requireApproval": "Require approval before ingest",
  "settings.general.language": "Interface language",
  "settings.general.languageHint":
    "UI copy only — page content language is governed by the CLAUDE.md contract.",
  "settings.models.slots": "Model slots",
  "settings.models.routing": "Format routing",
  "settings.models.routingHint":
    "Different formats are routed to different model slots automatically.",
  "settings.resetToDefaults": "Reset to configured defaults",
  "settings.saved": "Saved",

  // ---- language switcher ----
  "lang.switch": "Switch language",
  "lang.zh": "中文",
  "lang.en": "English",

  // ---- onboarding ----
  "onboarding.welcome": "Welcome to LLM Wiki",
  "onboarding.topicLabel": "What is this wiki about?",
  "onboarding.topicPlaceholder": "e.g. ConST326 intelligent pressure calibrator",
  "onboarding.continue": "Get started",
  "onboarding.skip": "Later",
};

export const enMessages: Messages = en;
