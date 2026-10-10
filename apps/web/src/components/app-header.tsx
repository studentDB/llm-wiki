"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useI18n } from "@/components/language-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { WikiSwitcher } from "@/components/wiki-switcher";
import { LanguageToggle } from "@/components/language-toggle";
import { cn } from "@/lib/utils";

// Primary destinations — what most actions converge on. Reads in the order a
// user would naturally encounter them in a session (knowledge in, knowledge
// out, conversation, hygiene). Labels are looked up through the i18n
// dictionary keyed by href so the structure stays static while text localizes.
const PRIMARY_NAV = [
  { labelKey: "nav.wiki", href: "/wiki" },
  { labelKey: "nav.graph", href: "/graph" },
  { labelKey: "nav.sources", href: "/sources" },
  { labelKey: "nav.query", href: "/query" },
  { labelKey: "nav.chats", href: "/chats" },
  { labelKey: "nav.lint", href: "/lint" },
] as const;

// Utility cluster — config + meta. Kept visually separate from primary nav.
const UTIL_NAV = [
  { labelKey: "nav.schema", href: "/schema" },
  { labelKey: "nav.settings", href: "/settings" },
] as const;

export function AppHeader() {
  const pathname = usePathname();
  const { t } = useI18n();
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <header className="sticky top-0 z-50 flex h-14 shrink-0 items-center gap-6 border-b border-border/70 bg-background/85 px-5 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      {/* Wordmark — Fraunces gives the scholarly voice docs/08 asked for. */}
      <Link
        href="/"
        className="group flex items-center gap-2.5"
        aria-label={t("common.home")}
      >
        <span
          aria-hidden
          className="font-mono text-[15px] leading-none text-primary transition-transform group-hover:scale-110"
        >
          [[
        </span>
        <span className="font-display text-[17px] font-semibold tracking-tight">
          LLM Wiki
        </span>
      </Link>

      {/* Active-wiki chip + dropdown. Sits next to the wordmark so the
          "which wiki am I in" answer is always one glance away, and one
          click reveals the switcher. Full CRUD lives in Settings → Wikis. */}
      <div className="hidden sm:block">
        <WikiSwitcher />
      </div>

      {/* Primary destinations — left-anchored next to wordmark so the cluster
          reads as one navigation system. Active item gets a thin underline. */}
      <nav className="hidden items-center gap-5 text-ui sm:flex">
        {PRIMARY_NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn("nav-link", isActive(item.href) && "is-active")}
          >
            {t(item.labelKey)}
          </Link>
        ))}
      </nav>

      <div className="flex flex-1 items-center justify-end gap-3">
        {/* Hint at Cmd+K — visible affordance for the command palette.
            Sans font (not mono) so the ⌘ glyph renders cleanly at small
            sizes; mono fonts often mis-baseline it. */}
        <kbd className="hidden h-6 items-center gap-0.5 rounded-md border border-border bg-muted/60 px-1.5 font-sans text-[11px] font-medium leading-none text-muted-foreground md:inline-flex">
          <span>⌘</span>K
        </kbd>

        <nav className="hidden items-center gap-4 text-ui sm:flex">
          {UTIL_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn("nav-link", isActive(item.href) && "is-active")}
            >
              {t(item.labelKey)}
            </Link>
          ))}
        </nav>

        <ThemeToggle />
        <LanguageToggle />

        {/* Compact mobile nav — only on small screens. Wiki-switcher link
            at the top so mobile users have a quick-switch affordance too. */}
        <details className="relative sm:hidden">
          <summary className="cursor-pointer list-none rounded p-1 text-muted-foreground hover:text-foreground">
            <span className="font-mono text-sm">≡</span>
          </summary>
          <div className="absolute right-0 mt-2 w-52 overflow-hidden rounded-md border border-border bg-popover py-1 text-ui shadow-lg">
            <Link
              href="/settings?tab=wikis"
              className="block border-b border-border/60 px-3 py-1.5 text-caption uppercase tracking-wider text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {t("nav.manageWikis")}
            </Link>
            {[...PRIMARY_NAV, ...UTIL_NAV].map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "block px-3 py-1.5 hover:bg-accent",
                  isActive(item.href) && "text-primary",
                )}
              >
                {t(item.labelKey)}
              </Link>
            ))}
          </div>
        </details>
      </div>
    </header>
  );
}
