export type Locale = "zh-CN" | "en";

export const LOCALES: Locale[] = ["zh-CN", "en"];

export const DEFAULT_LOCALE: Locale = "zh-CN";

/** Flat `<namespace>.<module>.<field>` keys keep diffing and linting trivial. */
export type Messages = Record<string, string>;

/** Simple `{name}` interpolation — no ICU machinery needed for UI strings. */
export type TVars = Record<string, string | number>;
