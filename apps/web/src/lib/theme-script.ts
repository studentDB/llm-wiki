// Theme bootstrap shared across the server/client boundary.
//
// Same reason `@/lib/i18n` carries its init script instead of the provider:
// `theme-provider.tsx` is "use client", and importing a *function* from it into
// a server component yields a client reference that throws when called. String
// constants survive that trip, but a constant can't take the deployment's
// configured theme as a parameter — which is exactly how `ui.theme` in
// llm-wiki.config.json ended up dead (hard-coded `|| 'auto'`, nobody read it).
//
// Keeping the generator here means the config value can be threaded through
// without moving the provider off the client boundary.

export type UiTheme = "light" | "dark" | "auto";

export const THEME_STORAGE_KEY = "llm-wiki:theme";

export function isUiTheme(value: unknown): value is UiTheme {
  return value === "light" || value === "dark" || value === "auto";
}

/**
 * Inlined into `<head>` before hydration so there's no light→dark flash.
 *
 * Priority mirrors the i18n script: the user's stored pick wins, and the
 * deployment default (from `llm-wiki.config.json → ui.theme`) only applies
 * when nothing has been chosen yet.
 */
export function themeInitScript(defaultTheme: UiTheme): string {
  const fallback = defaultTheme === "auto" ? "auto" : defaultTheme;
  return [
    "(function(){try{",
    `var t=localStorage.getItem('${THEME_STORAGE_KEY}')||'${fallback}';`,
    "var d=t==='dark'||(t==='auto'&&matchMedia('(prefers-color-scheme: dark)').matches);",
    "if(d)document.documentElement.classList.add('dark');",
    "}catch(e){}})();",
  ].join("");
}
