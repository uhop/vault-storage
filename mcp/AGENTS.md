# AGENTS.md — @uhop/vault-storage-mcp

Sub-package of [vault-storage](https://github.com/uhop/vault-storage); the
repo-wide rules live in [../AGENTS.md](../AGENTS.md). This file carries only
the sub-package delta.

## Local rules

- **Plain JavaScript (ES modules), no build step.** The parent's
  TypeScript-under-type-stripping rules do not apply here; zod input schemas
  carry the typing. There is no `ts-check` script in this package.
- **Thin adapter only.** No vault state, no business logic — every tool
  forwards to the REST server. Data-loss guards (empty body, null FM values,
  shadow conflicts) live at the server's storage boundary; do not duplicate
  them client-side (a guard added to one client is a guard the other N
  clients do not have).
- **Tool descriptions are contract.** Every description names the response
  shape it returns, including conditional keys and which of the three list
  shapes it uses. Any change that alters a shape must update the description
  and the pins in `tests/test-tool-descriptions.js` in the same change —
  the pins exist so a shape edit cannot ship with stale prose.
- **Tests**: `npm test` (tape-six over `tests/test-*.js`) — fake-fetch client
  tests, registration smoke tests, description pins. No network, no running
  server required.
- **Transport is stdio-only.** hono/express never load at runtime — relevant
  when triaging transitive dependency advisories.
- **Releases**: monorepo-naked tags `mcp-X.Y.Z` (no `v` prefix); version
  bumps land together with a regenerated `package-lock.json`; `npm publish`
  is the maintainer's step (interactive 2FA).
