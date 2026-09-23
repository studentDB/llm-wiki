import type { Db } from "./db";
import { PAGE_TYPES, type PageRow, type PageType } from "./types";

type PageRowDb = {
  slug: string;
  title: string;
  type: string;
  created_at: string;
  updated_at: string;
  word_count: number;
  tags: string | null;
};

function rowFromDb(r: PageRowDb): PageRow {
  if (!PAGE_TYPES.includes(r.type as PageType)) {
    throw new Error(`pages.${r.slug}: unknown type in DB: ${r.type}`);
  }
  return {
    slug: r.slug,
    title: r.title,
    type: r.type as PageType,
    created_at: r.created_at,
    updated_at: r.updated_at,
    word_count: r.word_count,
    tags: r.tags ? (JSON.parse(r.tags) as string[]) : [],
  };
}

export function insertPage(db: Db, page: PageRow): void {
  db.prepare(
    `INSERT INTO pages (slug, title, type, created_at, updated_at, word_count, tags)
     VALUES (@slug, @title, @type, @created_at, @updated_at, @word_count, @tags)`,
  ).run({ ...page, tags: JSON.stringify(page.tags) });
}

export function updatePage(db: Db, page: PageRow): void {
  const info = db
    .prepare(
      `UPDATE pages
         SET title = @title,
             type = @type,
             created_at = @created_at,
             updated_at = @updated_at,
             word_count = @word_count,
             tags = @tags
       WHERE slug = @slug`,
    )
    .run({ ...page, tags: JSON.stringify(page.tags) });
  if (info.changes === 0) {
    throw new Error(`updatePage: no row with slug '${page.slug}'`);
  }
}

export function upsertPage(db: Db, page: PageRow): void {
  db.prepare(
    `INSERT INTO pages (slug, title, type, created_at, updated_at, word_count, tags)
     VALUES (@slug, @title, @type, @created_at, @updated_at, @word_count, @tags)
     ON CONFLICT(slug) DO UPDATE SET
       title = excluded.title,
       type = excluded.type,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       word_count = excluded.word_count,
       tags = excluded.tags`,
  ).run({ ...page, tags: JSON.stringify(page.tags) });
}

export function getPage(db: Db, slug: string): PageRow | null {
  const row = db.prepare(`SELECT * FROM pages WHERE slug = ?`).get(slug) as PageRowDb | undefined;
  return row ? rowFromDb(row) : null;
}

export function deletePage(db: Db, slug: string): void {
  db.prepare(`DELETE FROM pages WHERE slug = ?`).run(slug);
}

export function listPageRows(db: Db): PageRow[] {
  const rows = db.prepare(`SELECT * FROM pages ORDER BY slug`).all() as PageRowDb[];
  return rows.map(rowFromDb);
}

// ---- page <-> source link table -------------------------------------------

export function linkPageSource(db: Db, pageSlug: string, sourceId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO page_sources (page_slug, source_id) VALUES (?, ?)`,
  ).run(pageSlug, sourceId);
}

export function unlinkPageSource(db: Db, pageSlug: string, sourceId: string): void {
  db.prepare(`DELETE FROM page_sources WHERE page_slug = ? AND source_id = ?`).run(
    pageSlug,
    sourceId,
  );
}

export function listSourceIdsForPage(db: Db, pageSlug: string): string[] {
  const rows = db
    .prepare(`SELECT source_id FROM page_sources WHERE page_slug = ? ORDER BY source_id`)
    .all(pageSlug) as Array<{ source_id: string }>;
  return rows.map((r) => r.source_id);
}

// ---- FTS5 -----------------------------------------------------------------

export function indexPageForSearch(
  db: Db,
  args: { slug: string; title: string; content: string; tags: string[] },
): void {
  // Delete any prior row for the slug, then insert. FTS5 doesn't have a real
  // upsert path; this is the documented pattern.
  db.prepare(`DELETE FROM pages_fts WHERE slug = ?`).run(args.slug);
  db.prepare(
    `INSERT INTO pages_fts (slug, title, content, tags) VALUES (?, ?, ?, ?)`,
  ).run(args.slug, args.title, args.content, args.tags.join(" "));
}

export function unindexPageFromSearch(db: Db, slug: string): void {
  db.prepare(`DELETE FROM pages_fts WHERE slug = ?`).run(slug);
}

export type SearchHit = { slug: string; title: string; snippet: string };

// FTS5 treats hyphens, colons, parens, etc. as operators, so every emitted term
// is quoted. Whitespace-delimited tokens are OR'd for broad recall.
//
// CJK needs extra handling: Chinese questions contain no spaces, so a whole
// sentence collapses into a single phrase. Under the `trigram` tokenizer a phrase
// must match contiguously, which means "差压版的压力发生范围和分辨力分别是多少？"
// matched nothing even though the answer page contained every keyword. CJK runs
// are therefore expanded into sliding 3-character phrases (the trigram width),
// which makes each keyword independently matchable. BM25 still ranks pages that
// contain several of the trigrams highest.
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]{3,}/g;
const MAX_FTS_TERMS = 64;

function quoteTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

function sanitizeFtsQuery(q: string): string {
  const tokens = q.trim().split(/\s+/).filter(Boolean);
  const terms: string[] = [];

  for (const token of tokens) {
    const runs = token.match(CJK_RUN);
    if (!runs) {
      terms.push(quoteTerm(token));
      continue;
    }
    for (const run of runs) {
      for (let i = 0; i + 3 <= run.length; i += 1) {
        terms.push(quoteTerm(run.slice(i, i + 3)));
      }
    }
  }

  return terms.slice(0, MAX_FTS_TERMS).join(" OR ");
}

export function searchPages(db: Db, query: string, limit = 20): SearchHit[] {
  const sanitized = sanitizeFtsQuery(query);
  if (sanitized.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT slug, title, snippet(pages_fts, 2, '[', ']', '...', 16) AS snippet
         FROM pages_fts
        WHERE pages_fts MATCH ?
        ORDER BY rank
        LIMIT ?`,
    )
    .all(sanitized, limit) as SearchHit[];
  return rows;
}
