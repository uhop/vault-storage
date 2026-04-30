---
name: vault-search
description: Search the vault for notes matching a query. Backed by `POST /search/simple/` — works against both the Obsidian Local REST API (lexical only) and vault-storage (lexical + semantic). Use when the user says /vault-search, asks to find notes matching a phrase, or wants to locate the right note to read before answering a question. Returns ranked hits with snippets.
user_invocable: true
---

# Vault — search

Run a single search query against the vault and return ranked hits. The dominant entry point for "is there already a note about X?" — cheaper than reading `_index.md` and skimming, more accurate than guessing filenames.

## Invocation

```
/vault-search <query>                # lexical, limit 20
/vault-search <query> --semantic     # embedding-NN (vault-storage only)
/vault-search <query> --limit=N      # cap results (1..100)
```

Combinable: `/vault-search auth flow --semantic --limit=10`.

`<query>` may contain spaces and quotes; pass it through verbatim. Don't strip or normalize.

## Procedure

1. **Parse args** from `$ARGUMENTS`:
   - Extract `--semantic` flag → `mode=semantic` else `mode=lexical`.
   - Extract `--limit=N` → integer; default 20; clamp to `[1, 100]`.
   - The remaining tokens (joined with single spaces) are the query.

2. **Call the endpoint** via vault-curl:

   ```bash
   vault-curl /search/simple/ -X POST -G \
     --data-urlencode "query=$QUERY" \
     --data-urlencode "mode=$MODE" \
     --data-urlencode "limit=$LIMIT"
   ```

   `-G --data-urlencode` produces a POST with the params as URL query (the shape the endpoint expects).

3. **Parse the JSON response.** Shape: `[{filename, score, matches: [{match: {start, end}, context}]}]`.
   - Lexical mode: `matches` is non-empty (up to 5 spans per file).
   - Semantic mode: `matches` is `[]`; the score is `1 − distance/2` (0..1, higher = more similar).

4. **Format for the user**:

   ```
   ### N hits for "<query>" (mode=<mode>)

   1. **<filename>** — score <score>
      > <context excerpt>
      > <context excerpt>
   2. **<filename>** — score <score>
      > <context excerpt>
   …
   ```

   For semantic results (no contexts), drop the `>` lines and just list filename + score.

5. **Empty results.** If the response is `[]`:
   - In lexical mode: tell the user, and suggest `--semantic` if the query is conceptual (paraphraseable) rather than a literal string.
   - In semantic mode: tell the user; suggest dropping `--semantic` if the query is a verbatim phrase.

## Result interpretation

- **Lexical scoring is ordinal, not absolute** — the two backends use different formulas. Obsidian Local REST API returns BM25-style scores (often negative; smaller magnitudes for better matches in some scoring variants). vault-storage returns `(body matches) + 3 × (title matches)`. Treat the order returned by the endpoint as authoritative; don't reason about the numeric score across backends.
- **Semantic scoring**: 1 = identical embedding; ~0.7+ = strong match; ~0.5 = topical neighbour; < 0.4 = noise. Don't filter on threshold by default — return whatever the endpoint ranked.

When the user is researching a topic, the natural next step after a search is to read the top hit. Offer it: "Want me to read `<top-hit>`?" — don't auto-read unless the user clearly just wants the content (e.g. asked for "the note on X", not "find the note on X").

## Backend compatibility

| Backend                          | Lexical | Semantic           | Honors `limit` |
| -------------------------------- | ------- | ------------------ | -------------- |
| Obsidian Local REST API (`:8089`) | yes     | param ignored → lexical | **no** — returns all hits |
| vault-storage (`:8123`)          | yes     | yes                | yes |

The skill works against whichever URL `$VAULT_API_URL` points at. If `--semantic` is requested but the backend doesn't support it, results will silently fall back to lexical — acceptable for now; flag it to the user only if the result shape suggests a fallback occurred (lexical hits returned when the user wanted embedding similarity).

**Truncate client-side.** Obsidian's `/search/simple/` ignores the `limit` query param and returns every hit. Always slice the JSON response to the requested limit before formatting — don't trust the server to do it. After cutover to `:8123` this becomes a no-op (server already truncates).

## Dependencies

- `vault-curl` on `$PATH` — standard for the vault skills.
- Falls back to raw `curl` with `Authorization: Bearer $VAULT_API_TOKEN` if `vault-curl` is missing.
