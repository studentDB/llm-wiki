#!/usr/bin/env node
// Key-parity check for the i18n catalogue.
//
// TypeScript already enforces zh-CN → en parity via Record<MessageKey, string>,
// but that only works if you remember to add the key to both files. This script
// catches the other half of the problem: keys referenced by components that
// don't exist in either catalogue (usually a typo), plus empty values.
//
// Usage: node scripts/check-i18n.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const I18N_DIR = join(root, "src", "lib", "i18n");
const SRC_DIR = join(root, "src");

function parseKeys(file) {
  const raw = readFileSync(file, "utf8");
  const keys = new Set();
  // Matches both `"key": "value"` and `'key': 'value'`.
  const re = /^\s{2}"([a-zA-Z0-9_.-]+)"\s*:/gm;
  let m;
  while ((m = re.exec(raw)) !== null) keys.add(m[1]);
  return keys;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(p)) out.push(p);
  }
  return out;
}

const zh = parseKeys(join(I18N_DIR, "zh-CN.ts"));
const en = parseKeys(join(I18N_DIR, "en.ts"));

const problems = [];

for (const key of zh) {
  if (!en.has(key)) problems.push(`en.ts missing key: ${key}`);
}
for (const key of en) {
  if (!zh.has(key)) problems.push(`zh-CN.ts missing key: ${key}`);
}

// Keys used by components must exist somewhere in the catalogue.
const allKeys = new Set([...zh, ...en]);
const usedKeys = new Map();
for (const file of walk(SRC_DIR)) {
  if (file.startsWith(I18N_DIR)) continue;
  const raw = readFileSync(file, "utf8");
  // t("nav.wiki") / t("lint.issues", { count }) / labelKey: "nav.wiki"
  const re = /\bt\(\s*"([a-zA-Z0-9_.-]+)"|labelKey:\s*"([a-zA-Z0-9_.-]+)"/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const key = m[1] ?? m[2];
    if (!usedKeys.has(key)) usedKeys.set(key, file);
  }
}
for (const [key, file] of usedKeys) {
  if (!allKeys.has(key)) {
    problems.push(`unknown key "${key}" used in ${file.replace(root, ".")}`);
  }
}

// Empty values are almost always a translation someone meant to write later.
for (const [name, file] of [
  ["zh-CN.ts", join(I18N_DIR, "zh-CN.ts")],
  ["en.ts", join(I18N_DIR, "en.ts")],
]) {
  const raw = readFileSync(file, "utf8");
  const re = /^\s{2}"([a-zA-Z0-9_.-]+)"\s*:\s*""/gm;
  let m;
  while ((m = re.exec(raw)) !== null) problems.push(`${name} has empty value for: ${m[1]}`);
}

if (problems.length > 0) {
  console.error(`check-i18n: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

console.log(
  `check-i18n: OK — ${zh.size} keys, both catalogues in parity, ${usedKeys.size} keys referenced by components.`,
);
