import type { Metadata } from "next";
import { Crimson_Pro, Fraunces, Inter, JetBrains_Mono } from "next/font/google";

import { AppShell } from "@/components/app-shell";
import { CommandPalette } from "@/components/command-palette";
import { LanguageProvider } from "@/components/language-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { languageInitScript, type Locale } from "@/lib/i18n";
import { themeInitScript, type UiTheme } from "@/lib/theme-script";
import { getRuntimeConfig } from "@llm-wiki/llm";

import "./globals.css";

// Loaded via next/font so they're hashed, preloaded, and CLS-free. The CSS
// vars below get bound to Tailwind's font-sans / font-serif / font-display /
// font-mono in tailwind.config.ts.
const fontSans = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});
const fontSerif = Crimson_Pro({
  subsets: ["latin"],
  variable: "--font-serif",
  display: "swap",
  weight: ["400", "500", "600"],
});
const fontDisplay = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
  weight: ["500", "600", "700"],
});
const fontMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

// Default UI locale ships with the deployment instead of being hard-coded:
// llm-wiki.config.json → ui.language (falls back to zh-CN).
const runtimeConfig = getRuntimeConfig();
const defaultLocale: Locale = runtimeConfig.ui.language;
// Threaded into both the pre-hydration script and the provider so the config
// value actually decides the first paint. Both still let a stored user choice
// win — config is a *default*, never an override.
const defaultTheme: UiTheme = runtimeConfig.ui.theme;

export const metadata: Metadata = {
  title: "LLM Wiki",
  description:
    defaultLocale === "zh-CN"
      ? "本地优先的知识库，由 LLM 代理维护。"
      : "Local-first knowledge base maintained by an LLM agent.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang={defaultLocale}
      data-default-theme={defaultTheme}
      suppressHydrationWarning
      className={`${fontSans.variable} ${fontSerif.variable} ${fontDisplay.variable} ${fontMono.variable}`}
    >
      <head>
        {/* Runs before hydration to avoid a light->dark flash on first paint.
            Uses the configured default only when the user has never picked. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript(defaultTheme) }} />
        {/* Same reason, for language: set <html lang> on the first paint. */}
        <script dangerouslySetInnerHTML={{ __html: languageInitScript(defaultLocale) }} />
      </head>
      <body className="flex h-screen flex-col overflow-hidden">
        <ThemeProvider defaultTheme={defaultTheme}>
          <LanguageProvider defaultLocale={defaultLocale}>
            <AppShell>{children}</AppShell>
            <CommandPalette />
          </LanguageProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
