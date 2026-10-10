import { en } from "./en";
import type { Locale, Messages, TVars } from "./types";
import { zhCN } from "./zh-CN";

export * from "./types";
export type { MessageKey } from "./zh-CN";

// DEFAULT_LOCALE comes from ./types via the `export *` above — don't redeclare.
export const LANGUAGE_STORAGE_KEY = "llm-wiki:locale";

export const messages: Record<"zh-CN" | "en", Messages> = {
  "zh-CN": zhCN as unknown as Messages,
  en: en as unknown as Messages,
};

export function getDictionary(locale: "zh-CN" | "en"): Messages {
  return messages[locale] ?? messages["zh-CN"];
}

/**
 * Inlined into <head> by the root layout — a server component. It has to live
 * here rather than in language-provider.tsx: that module is "use client", and a
 * client module imported from the server only hands back client references, so
 * a *function* export would arrive as a proxy and throw at render time.
 * `@/lib/theme-script.ts` follows the same rule for the theme bootstrap.
 */
export function languageInitScript(defaultLocale: Locale): string {
  return `(function(){try{var l=localStorage.getItem('${LANGUAGE_STORAGE_KEY}')||'${defaultLocale}';document.documentElement.lang=l;}catch(e){}})();`;
}

/** Substitute `{name}` placeholders. Missing values render as-is so a typo is
 *  visible in the UI instead of silently producing "undefined". */
export function interpolate(template: string, vars?: TVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}
