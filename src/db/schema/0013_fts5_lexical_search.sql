-- 0013 — FTS5 external-content index for lexical search.
--
-- Replaces the `LOWER(body) LIKE '%term%'` full-table scan + hand-rolled
-- scorer in src/server/handlers/search.ts with an indexed FTS5 MATCH:
-- bm25() ranking (title column-weighted), prefix/phrase/boolean queries,
-- and a real inverted index instead of an O(rows) scan.
--
-- External-content (content='records', content_rowid='rowid'): the FTS table
-- stores only the inverted index and reads title/body from `records` on
-- demand via rowid. Kept in sync by the triggers below — same cascade-trigger
-- pattern as 0007/0009. The unicode61 tokenizer case-folds and strips
-- diacritics (remove_diacritics 2).
--
-- DEPENDS ON records.rowid: the index is keyed on the records rowid. A future
-- migration that rebuilds `records` (as 0011 did — which reassigns rowids)
-- MUST also rebuild this index: DROP TABLE records_fts, recreate, and
-- re-run the 'rebuild' command, or the rowid linkage silently breaks.
--
-- Backfilled here (unlike 0012's forward-only modified_at): lexical search
-- must cover every existing note, and the index is fully derivable from
-- `records` — the 'rebuild' command repopulates it from the content table.

CREATE VIRTUAL TABLE records_fts USING fts5(
  title,
  body,
  content='records',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

INSERT INTO records_fts(records_fts) VALUES ('rebuild');

CREATE TRIGGER records_fts_ai AFTER INSERT ON records BEGIN
  INSERT INTO records_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TRIGGER records_fts_ad AFTER DELETE ON records BEGIN
  INSERT INTO records_fts(records_fts, rowid, title, body)
    VALUES ('delete', old.rowid, old.title, old.body);
END;

CREATE TRIGGER records_fts_au AFTER UPDATE ON records BEGIN
  INSERT INTO records_fts(records_fts, rowid, title, body)
    VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO records_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

UPDATE meta SET value = '13' WHERE key = 'schema_version';
