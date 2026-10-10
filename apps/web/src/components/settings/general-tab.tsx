"use client";

import { useEffect, useState } from "react";

import { useI18n } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTheme, type UiTheme } from "@/components/theme-provider";

type SettingsResponse = {
  settings: {
    topic: string;
    requireApprovalForIngest?: boolean;
  };
  wikiPath: string;
};

export function GeneralTab() {
  const { theme, setTheme } = useTheme();
  const { locale, setLocale, t } = useI18n();
  const [themeMounted, setThemeMounted] = useState(false);
  useEffect(() => setThemeMounted(true), []);

  const [topic, setTopic] = useState<string>("");
  const [original, setOriginal] = useState<string>("");
  const [wikiPath, setWikiPath] = useState<string>("");
  const [requireApproval, setRequireApproval] = useState(false);
  const [approvalSaving, setApprovalSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/settings", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as SettingsResponse;
        setTopic(data.settings.topic);
        setOriginal(data.settings.topic);
        setWikiPath(data.wikiPath);
        setRequireApproval(Boolean(data.settings.requireApprovalForIngest));
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, []);

  async function toggleRequireApproval(next: boolean) {
    setApprovalSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requireApprovalForIngest: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRequireApproval(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setApprovalSaving(false);
    }
  }

  async function onSave() {
    setBusy(true);
    setFlash(null);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setOriginal(topic);
      setFlash(t("settings.saved"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const dirty = topic !== original;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium">{t("settings.general.topic")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {locale === "zh-CN"
            ? "一句话描述本知识库的范围。每次入库和问答都会读取它，请尽量具体。"
            : "A one-line description of this wiki's scope. The agent reads it on every ingest and query, so be specific."}
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder={
              locale === "zh-CN" ? "例如：ConST326 智能压力校验仪" : "e.g. Quantum computing research"
            }
            className="sm:flex-1"
          />
          <Button onClick={onSave} disabled={!dirty || busy}>
            {busy ? t("common.loading") : t("common.save")}
          </Button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Saved to <code>{wikiPath || "<wiki>"}/.llm-wiki/settings.json</code>
        </p>

        <div className="mt-4 rounded-md border border-border/70 bg-muted/30 p-3 text-xs text-muted-foreground">
          <p>
            <strong className="text-foreground">One topic per wiki, by design.</strong> A wiki is
            one folder; the topic above describes that folder&apos;s scope. To keep multiple
            topics separate (e.g. Quantum Computing <em>and</em> Machine Learning), create a
            second wiki folder and point the app at it:
          </p>
          <pre className="mt-2 overflow-x-auto rounded bg-background/70 p-2 font-mono text-[11px] text-foreground/80">
{`# stop the dev server, then:
export LLM_WIKI_PATH=~/llm-wiki-machine-learning
pnpm dev

# or via the CLI:
llm-wiki start ~/llm-wiki-machine-learning`}
          </pre>
          <p className="mt-2">
            Per Karpathy&apos;s pattern, each wiki is a self-contained corpus. Switching folders
            switches every page, chat, source, and schema in one go.
          </p>
        </div>
      </div>

      <div>
        <h2 className="text-lg font-medium">{t("settings.general.requireApproval")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {locale === "zh-CN"
            ? "开启后，每次入库都会先展示 LLM 的修改提案（新增词条、更新、矛盾），你点确认后才会写入。"
            : "When on, every ingest shows you the LLM's proposed changes before anything is written."}
        </p>
        <label className="mt-3 flex items-center gap-2">
          <input
            type="checkbox"
            checked={requireApproval}
            disabled={approvalSaving}
            onChange={(e) => void toggleRequireApproval(e.target.checked)}
            className="h-4 w-4 rounded border-border"
          />
          <span className="text-sm">
            {t("settings.general.requireApproval")}
            {approvalSaving ? (
              <span className="ml-2 text-xs text-muted-foreground">
                {locale === "zh-CN" ? "保存中…" : "saving…"}
              </span>
            ) : null}
          </span>
        </label>
      </div>

      <div>
        <h2 className="text-lg font-medium">{t("settings.general.language")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.general.languageHint")}
        </p>
        <div className="mt-3 inline-flex rounded-md border border-border bg-secondary/40 p-1 text-sm">
          {(["zh-CN", "en"] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLocale(l)}
              className={
                "rounded px-3 py-1 " +
                (locale === l
                  ? "bg-background shadow-sm"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              {l === "zh-CN" ? t("lang.zh") : t("lang.en")}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-medium">Theme</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Applies immediately. Saved to <code>localStorage</code> so it persists across
          sessions.
        </p>
        {/* Server can't read localStorage, so render a placeholder until the
            client mounts. Avoids a hydration-mismatch on the active button's
            background color. */}
        {themeMounted ? (
          <div className="mt-3 inline-flex rounded-md border border-border bg-secondary/40 p-1 text-sm">
            {(["light", "dark", "auto"] as UiTheme[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTheme(t)}
                className={
                  "rounded px-3 py-1 capitalize " +
                  (theme === t
                    ? "bg-background shadow-sm"
                    : "text-muted-foreground hover:text-foreground")
                }
              >
                {t}
              </button>
            ))}
          </div>
        ) : (
          <div className="mt-3 inline-block h-9 w-[14rem] rounded-md border border-border bg-secondary/40" />
        )}
      </div>

      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {flash ? <p className="text-sm text-muted-foreground">{flash}</p> : null}
    </div>
  );
}
