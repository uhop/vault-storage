---
name: vault-similar
description: Find records semantically similar to a given vault note via embedding nearest-neighbours. Backed by `GET /sections/{record_id}/similar`. Use when the user says /vault-similar, asks "what other notes are like this one", or wants to discover related concepts beyond what's explicitly wikilinked. Returns ranked records by cosine similarity. Requires vault-storage (`:8123`) — Obsidian's REST API doesn't expose embeddings.
user_invocable: true
---

# Vault — semantic neighbours of a note

Returns the top-K embedding-nearest-neighbour records to a given record. Cheap (~1ms in-DB after the initial embed pass at import time). The complement to `/vault-search`: search starts from a query phrase, similar starts from an existing note.

## Invocation

```
/vault-similar <path>                # default k=10, e.g. "topics/edge-taxonomy.md"
/vault-similar <path> --k=N          # custom count (1..100)
/vault-similar --id <record_id>      # bypass path resolution (UUIDv7)
```

## Procedure

1. **Resolve to record_id** if a path was given:

   ```bash
   vault-curl "/sections?file_path=$(printf %s "$PATH" | jq -sRr @uri)" -s | jq -r '.items[0].record_id'
   ```

   If no record matches the path, tell the user "no record at <path>" and stop. If `--id` was given, skip this step.

2. **Call the endpoint**:

   ```bash
   vault-curl "/sections/$RECORD_ID/similar?k=$K" -s
   ```

   Response shape: `{root_id, k, items: [{record_id, file_path, title, score, distance, ...}]}`. Each item carries the full record (type, status, created, updated, content_hash). Score is cosine-derived (0..1, higher = more similar); distance is the raw cosine distance. Self is excluded by the server. Empty `items` array means the source record hasn't been embedded yet — surface that to the user instead of silently returning "no results."

3. **Format**:

   ```
   ### K similar records to <path>

   1. **<title or file_path>** (`<file_path>`) — score <s>
   2. **<title or file_path>** (`<file_path>`) — score <s>
   ...
   ```

   When `title` is null in the response, just show the `file_path`. Score 0.7+ = strong match, 0.5 = topical neighbour, < 0.4 = noise — but don't filter; show the server's K.

4. **Suggest a follow-up** when the top hit is meaningful: "Read the top hit?" or "Run `/vault-graph <top-hit>` to see its typed edges?" — only when the user is exploring, not when they've already named what they want.

## When this is the right tool

- "What else covers this topic?" — embedding NN catches conceptual matches the wikilink graph misses.
- After finding one relevant note via search, expand laterally to its embedding-neighbours.
- When `related:` arrays are sparse (the common case in this vault — see `vault-propose-related` skill).

## Backend requirement

Vault-storage on `:8123` only. Obsidian's `/search/simple/` doesn't have a per-record similarity endpoint. If `$VAULT_API_URL` points at `:8089`, the skill returns 404 — flag the cutover state to the user.

## Dependencies

- `vault-curl` on `$PATH`.
- `jq` for path encoding and response parsing.
