"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { useI18n } from "@/components/language-provider";
import { PageContainer, PageHeader } from "@/components/page-shell";
import { AboutTab } from "@/components/settings/about-tab";
import { ApiTab } from "@/components/settings/api-tab";
import { CostsTab } from "@/components/settings/costs-tab";
import { GeneralTab } from "@/components/settings/general-tab";
import { ModelsTab } from "@/components/settings/models-tab";
import { WikisTab } from "@/components/settings/wikis-tab";
import { cn } from "@/lib/utils";

type Tab = "general" | "wikis" | "models" | "api" | "costs" | "about";
const TAB_ORDER: Tab[] = ["general", "wikis", "models", "api", "costs", "about"];
// Keys are looked up per-tab so the labels localize without duplicating the
// structure that drives both the tablist and the pane switch below.
const TAB_LABEL_KEY: Record<Tab, string> = {
  general: "settings.tabs.general",
  wikis: "settings.tabs.wikis",
  models: "settings.tabs.models",
  api: "settings.tabs.api",
  costs: "settings.tabs.costs",
  about: "settings.tabs.about",
};

const UI_COPY = {
  eyebrow: { "zh-CN": "配置", en: "Configuration" },
  description: {
    "zh-CN":
      "每个知识库的偏好设置保存在该知识库目录内；密钥保存在系统钥匙串（或回退到 ~/.llm-wiki/config.json）。",
    en: "Per-wiki preferences live in your wiki folder. The API key lives in your OS keychain (or ~/.llm-wiki/config.json as fallback).",
  },
} as const;

function parseTab(raw: string | null): Tab {
  return TAB_ORDER.includes(raw as Tab) ? (raw as Tab) : "general";
}

export default function SettingsPage() {
  const search = useSearchParams();
  // Read ?tab= on mount so links like /settings?tab=wikis (from the header
  // dropdown or anywhere else) deep-link straight to the right pane.
  const initialTab = parseTab(search?.get("tab") ?? null);
  const [tab, setTab] = useState<Tab>(initialTab);
  const { locale, t } = useI18n();
  useEffect(() => {
    const next = parseTab(search?.get("tab") ?? null);
    setTab(next);
  }, [search]);

  return (
    <PageContainer>
      <PageHeader
        eyebrow={UI_COPY.eyebrow[locale]}
        title={t("settings.title")}
        description={UI_COPY.description[locale]}
      />

      <nav
        role="tablist"
        className="mb-5 inline-flex rounded-md border border-border/70 bg-secondary/40 p-1 text-ui"
      >
        {TAB_ORDER.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
            className={cn(
              "rounded px-3 py-1",
              tab === name
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(TAB_LABEL_KEY[name])}
          </button>
        ))}
      </nav>

      <section className="rounded-lg border border-border/70 bg-card p-5 text-card-foreground">
        {tab === "general" ? <GeneralTab /> : null}
        {tab === "wikis" ? <WikisTab /> : null}
        {tab === "models" ? <ModelsTab /> : null}
        {tab === "api" ? <ApiTab /> : null}
        {tab === "costs" ? <CostsTab /> : null}
        {tab === "about" ? <AboutTab /> : null}
      </section>
    </PageContainer>
  );
}
