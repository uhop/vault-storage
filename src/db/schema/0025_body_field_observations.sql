-- 0025 — JSON body fields the server does not read, per route and client
-- (D64, 2026-09-19). The routes read the fields they declare and ignore the
-- rest, so a field a client sends that nothing reads fails nobody. A week of
-- these rows decides which routes can refuse unknown fields without breaking
-- a client. `field` '' counts the route's JSON requests, so a route with no
-- traffic reads as untested rather than clean.
-- migrate:no-reindex

CREATE TABLE body_field_observations (
  route      TEXT NOT NULL,
  field      TEXT NOT NULL,
  client     TEXT NOT NULL,
  count      INTEGER NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  PRIMARY KEY (route, field, client)
) WITHOUT ROWID;

UPDATE meta SET value = '25' WHERE key = 'schema_version';
