---
name: vault-graph
description: Walk the typed-edge neighborhood around a vault note. Backed by `GET /sections/{record_id}/neighborhood`. Use when the user says /vault-graph, asks "what does this note connect to and how", wants to see the wiki-link / classified-edge structure around a record, or needs to expand context beyond a single note. Returns layered records + typed edges; depth caps at 5. Requires vault-storage (`:8123`).
user_invocable: true
---

# Vault — typed-edge neighborhood

BFS walk of typed edges (`cites`, `related-to`, `supersedes`, `derived-from`, …) starting from a record. The structural complement to `/vault-similar`: similar uses embeddings (semantic), graph uses the explicit edge classifier (relational). Useful when you need to know *how* two notes connect, not just *that* they're related.

## Invocation

```
/vault-graph <path>                          # default depth=1, both directions
/vault-graph <path> --depth=N                # 1..5
/vault-graph <path> --via=cites,related-to   # filter to listed edge types
/vault-graph <path> --direction=outbound     # outbound | inbound | both (default)
/vault-graph --id <record_id>                # bypass path resolution
```

Combinable. `--depth=2 --via=supersedes,revises` traces a chain of revisions two hops out.

## Procedure

1. **Resolve to record_id** if a path was given:

   ```bash
   vault-curl "/sections?file_path=$(printf %s "$PATH" | jq -sRr @uri)" -s | jq -r '.items[0].record_id'
   ```

   404 / empty `items` → tell the user "no record at <path>." Skip if `--id` was given.

2. **Call the endpoint**:

   ```bash
   vault-curl "/sections/$RECORD_ID/neighborhood?depth=$DEPTH&direction=$DIR&via=$VIA" -s
   ```

   `via` is comma-separated; omit it for unfiltered.

   Response shape:

   ```jsonc
   {
     "root_id": "...",
     "direction": "both",
     "depth": 1,
     "via": null,           // or array of types
     "layers": [
       {"depth": 1, "records": [{record_id, file_path, title, type, ...}]}
     ],
     "edges": [
       {"from_id": "...", "to_id": "...", "type": "cites", "weight": 1, "note": null, "created": "..."}
     ]
   }
   ```

   Layers are indexed by hop distance (1 = direct neighbours). `edges` covers all pairs touched in the walk.

3. **Format** as grouped output, one section per layer. Within a layer, list each neighbour with the edge type(s) connecting it to the previous layer. For `direction=both` the same neighbour may appear via different edge types — collapse to a comma-joined list per neighbour.

   ```
   ### Neighborhood of <path> (depth=N, direction=<dir>, via=<via or "all">)

   #### Depth 1 (M records)
   - **<title or file_path>** ← cites, related-to (`<file_path>`)
   - **<title or file_path>** → supersedes (`<file_path>`)

   #### Depth 2 (K records)
   - …
   ```

   `←` = inbound edge (other → root), `→` = outbound (root → other). When `direction=both` and the neighbourhood includes layer ≥ 2, edges between non-root records are also relevant — keep them simple by attributing each neighbour to the closest predecessor in the BFS, or just list edges in a footer if it gets noisy.

4. **Suggest follow-ups** when patterns emerge: a chain of `supersedes` edges → "Want me to read the latest in the chain?" A node with many `cites` inbound → "Most-cited at depth N: X." Don't force structure when the neighborhood is small.

## When this is the right tool

- Tracing a revision / supersedes chain to find the live version of a deprecated note.
- Asking "what does this design doc actually depend on?" — `derived-from` outbound at depth ≥ 2.
- Mapping the explicit (typed) graph around a topic to compare against `/vault-similar` (embedding) results — they should overlap but not match exactly. Disagreements are interesting.

## Edge type cheatsheet

10 closed types per the design's edge taxonomy:

| Type | Meaning |
| ---- | ------- |
| `cites` | Default for unclassified body wikilinks |
| `related-to` | Symmetric general relation; auto-mirrored |
| `supersedes` | A obsoletes B (asymmetric) |
| `revises` | A is a revision of B (asymmetric) |
| `derived-from` | A builds on B |
| `caused-by` / `fixed-by` | Bug-tracking flow |
| `rejected-because` | A rejected, citing B as reason |
| `applies-to` | Scope / context |
| `contradicts` | Symmetric disagreement; auto-mirrored |

## Backend requirement

Vault-storage on `:8123` only. Obsidian's REST API doesn't expose typed edges. Returns 404 against `:8089`.

## Dependencies

- `vault-curl` on `$PATH`.
- `jq` for path encoding and response shaping.
