"use client";

import { useEffect, useState } from "react";

import { Languages } from "lucide-react";

import { useI18n } from "@/components/language-provider";

// Two-way toggle, placed next to ThemeToggle in the header. The selected
// locale persists to localStorage and mirrors onto <html lang>.
//
// Same hydration dance as ThemeToggle: the server can't see localStorage, so
// render a sized placeholder until mount to keep markup identical. The
// LANGUAGE_INIT_SCRIPT in <head> sets <html lang> synchronously, which handles
// the text direction / font fallback before paint.
export function LanguageToggle() {
  const { locale, setLocale, t } = useI18n();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const next = locale === "zh-CN" ? "en" : "zh-CN";

  if (!mounted) {
    return <div className="h-8 w-8" aria-hidden />;
  }

  return (
    <button
      type="button"
      onClick={() => setLocale(next)}
      aria-label={`${t("lang.switch")}: ${t(next === "en" ? "lang.en" : "lang.zh")}`}
      title={`${t("lang.switch")}: ${t(next === "en" ? "lang.en" : "lang.zh")}`}
      className="inline-flex h-8 min-w-8 items-center justify-center rounded-md px-1 text-ui text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <Languages className="h-4 w-4" />
      <span className="ml-1 text-xs font-medium">{locale === "zh-CN" ? "中" : "EN"}</span>
    </button>
  );
}
