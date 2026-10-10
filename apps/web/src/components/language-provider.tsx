"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

import {
  DEFAULT_LOCALE,
  LANGUAGE_STORAGE_KEY,
  getDictionary,
  interpolate,
  type Locale,
  type Messages,
  type TVars,
} from "@/lib/i18n";

type LanguageContextValue = {
  locale: Locale;
  setLocale: (l: Locale) => void;
  /** Translate a key. Falls back to the key itself so a missing entry is obvious. */
  t: (key: string, vars?: TVars) => string;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

function readInitialLocale(fallback: Locale): Locale {
  if (typeof window === "undefined") return fallback;
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored === "zh-CN" || stored === "en") return stored;
  } catch {
    // Private mode / blocked storage — fall through to the configured default.
  }
  return fallback;
}

/**
 * `defaultLocale` comes from llm-wiki.config.json → ui.language (read server-side
 * and passed down), so a deployment can ship Chinese-first or English-first
 * without anyone clicking the toggle.
 */
export function LanguageProvider({
  children,
  defaultLocale = DEFAULT_LOCALE,
}: {
  children: React.ReactNode;
  defaultLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(() => readInitialLocale(defaultLocale));
  const [dictionary, setDictionary] = useState<Messages>(() => getDictionary(defaultLocale));

  useEffect(() => {
    setDictionary(getDictionary(locale));
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
    } catch {
      // ignore — language simply won't persist
    }
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  const setLocale = useCallback((next: Locale) => setLocaleState(next), []);

  const t = useCallback(
    (key: string, vars?: TVars) => {
      const template = dictionary[key];
      return template === undefined ? key : interpolate(template, vars);
    },
    [dictionary],
  );

  return (
    <LanguageContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useI18n(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useI18n must be used inside <LanguageProvider>");
  return ctx;
}

// The pre-hydration <html lang> script now lives in @/lib/i18n (see
// languageInitScript) — it can't live in this "use client" module because the
// root layout is a server component and would only receive a client reference.
