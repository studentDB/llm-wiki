"use client";

import { createContext, useContext, useEffect, useState } from "react";

import { isUiTheme, type UiTheme } from "@/lib/theme-script";

// Re-exported so existing `@/components/theme-provider` imports keep working.
export type { UiTheme };

type ThemeContextValue = {
  theme: UiTheme;
  setTheme: (t: UiTheme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);
const STORAGE_KEY = "llm-wiki:theme";

function applyDocumentTheme(theme: UiTheme): void {
  if (typeof document === "undefined") return;
  const isDark =
    theme === "dark" ||
    (theme === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", isDark);
}

/**
 * The user's stored pick wins; otherwise we start from whatever the deployment
 * configured (`llm-wiki.config.json → ui.theme`) and hand it down through the
 * root layout. It used to fall back to a hard-coded "auto", which silently
 * ignored that config key.
 */
function readInitialTheme(defaultTheme: UiTheme): UiTheme {
  if (typeof window === "undefined") return defaultTheme;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (isUiTheme(stored)) return stored;
  return defaultTheme;
}

export function ThemeProvider({
  children,
  defaultTheme = "auto",
}: {
  children: React.ReactNode;
  defaultTheme?: UiTheme;
}) {
  const [theme, setThemeState] = useState<UiTheme>(() => readInitialTheme(defaultTheme));

  useEffect(() => {
    applyDocumentTheme(theme);
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (theme !== "auto") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyDocumentTheme("auto");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme: setThemeState }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
