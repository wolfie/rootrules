# rootrules

The Law of Root (rules, FAQ and errata) from [LederCards/rules](https://github.com/LederCards/rules),
preprocessed for LLMs: explicit rule ids, resolved cross-references, and FAQ entries linked to the
rules they clarify.

Private use only: the upstream repository has no license and the rules text belongs to Leder Games.

## Getting started

Requires Node 24+ ([.nvmrc](.nvmrc) pins the version; TypeScript runs natively, no build step).

```sh
nvm use             # or any other way to get Node 24
npm install
npm run update      # download the rules and generate dist/
npm start           # serve MCP + REST on http://127.0.0.1:8787
```

That's a working local server. On localhost it needs no token, so you can connect right away:

```sh
claude mcp add --transport http root-rules http://127.0.0.1:8787/mcp
curl "http://127.0.0.1:8787/api/search?q=ambush"
```

Or skip the server and use the generated files in `dist/` directly (see [Outputs](#outputs-dist)).
For access from other machines, see [HTTP (remote)](#http-remote). For a phone chat UI on top of a local
model, see [Chat app](#chat-app).

## Updating the rules

```sh
npm run update      # = npm run fetch && npm run build
```

- `npm run fetch` downloads the newest printing (`p<N>` directory) of the English (`en-US`) rules from
  `master` of the upstream repository into `upstream/root/en-US/`, and records the upstream commit in
  `source.json` there. It does nothing if upstream hasn't changed. Set `GITHUB_TOKEN` to raise the GitHub
  API rate limit (60 requests/hour unauthenticated).
- `npm run build` generates `dist/` from that snapshot. Warnings point at upstream data problems (see
  [Known upstream issues](#known-upstream-issues)) and don't fail the build.

A running server picks up the rebuilt files within ~10 seconds, without a restart.

Both `upstream/` (downloaded) and `dist/` (generated) are git-ignored: this repository holds only the
tooling, and the rules themselves are always pulled fresh from upstream.

## Development

```sh
npm test            # node:test, against the upstream/ snapshot (run npm run fetch first)
npm run typecheck   # tsc, no emit
```

## Outputs (`dist/`)

| File | Use |
| --- | --- |
| `rules.md` | Everything in one file (~36k tokens): paste into a system prompt or context |
| `sections/*.md` | One file per top-level section, with the FAQ entries that cite it |
| `faq.md` | FAQ only |
| `keywords/*.md` | Reverse keyword index, one file per initial letter plus `index.md`. Each game term lists its main entries, every rule using it (grouped by section) and FAQ mentions |
| `llms.txt` | Index of the above ([llmstxt.org](https://llmstxt.org)) |
| `rulebook.json` | Structured data for tools/search: every rule with id, title, text, parent/children, breadcrumb, faction, cross-refs in both directions, FAQ/errata links |

## MCP server

Serves the built `dist/` data as an MCP server. It needs `npm run update` to have run at least once, and it
reloads `dist/rulebook.json` within ~10 seconds after each later update.

| Tool | Purpose |
| --- | --- |
| `search_rules` | Ranked full-text search over rules + FAQ; optional `faction` filter; understands nicknames ("cats") and rule ids |
| `get_rules` | Full text of rules by id with parent context, sub-rules, applicable FAQ/errata and cross-references both ways |
| `lookup_term` | Keyword index: definition and every use of a game term ("remove", "enemy piece") |
| `table_of_contents` | Section list, or outline of one section/faction |

It also provides resources (the full text, the FAQ, and each section) and an `arbitrate` prompt (`/mcp__root-rules__arbitrate` in Claude
Code). The server's instructions tell the model to research before ruling and to cite rule/FAQ ids.

### HTTP (remote)

```sh
ROOTRULES_TOKEN=$(openssl rand -hex 32) ALLOWED_HOSTS=rules.example.com npm start
```

- MCP endpoint: `/mcp` (Streamable HTTP, stateless). The REST API is under `/api/…` (see below). The generated
  files are served too: `/` (llms.txt), `/rules.md`, `/sections/…`, `/keywords/…`. `/healthz` and
  `/openapi.json` are unauthenticated.
- `ROOTRULES_TOKEN`: required as `Authorization: Bearer <token>` on every request. The server refuses to start on
  a non-loopback `HOST` without it. Set it behind a reverse proxy too.
- `HOST` (default `127.0.0.1`), `PORT` (default `8787`). For remote use, put a TLS reverse proxy in front and
  forward the original `Host` header.
- `ALLOWED_HOSTS`: hostnames clients use to reach the server (Host/Origin check against DNS rebinding).
  Default `localhost,127.0.0.1,[::1]`.
- `ROOTRULES_DIST`: directory with the built files, default `./dist`. Also read by the stdio server.

Clients:

```sh
# Claude Code
claude mcp add --transport http root-rules https://rules.example.com/mcp \
  --header "Authorization: Bearer $ROOTRULES_TOKEN"
```

```toml
# Codex (~/.codex/config.toml)
[mcp_servers.root-rules]
url = "https://rules.example.com/mcp"
bearer_token_env_var = "ROOTRULES_TOKEN"
```

```json
// LM Studio (mcp.json)
{ "mcpServers": { "root-rules": {
  "url": "https://rules.example.com/mcp",
  "headers": { "Authorization": "Bearer <token>" }
} } }
```

claude.ai web connectors need OAuth, which this server doesn't implement.

### OpenAPI (REST)

The same server (same port, same token) exposes the four tools as JSON endpoints for clients that speak
OpenAPI instead of MCP, such as custom GPT Actions, Open WebUI tool servers and scripts. Operation ids match the
MCP tool names.

| Endpoint | Operation |
| --- | --- |
| `GET /api/search?q=…&faction=…&limit=…` | `search_rules` |
| `GET /api/rules?ids=4.3.1,G.24&subrules=false` | `get_rules` |
| `GET /api/terms/{term}` | `lookup_term` |
| `GET /api/faq/{id}` | `get_faq` (REST only) |
| `GET /api/contents?section=…` | `table_of_contents` |

- The spec is at `/openapi.json`. It's public so clients can import it before credentials are set up.
- The spec's server URL is derived from the request, including `X-Forwarded-Proto/Host` from a proxy. Set
  `PUBLIC_URL` to override it.
- Browser-based clients get CORS headers. This includes Open WebUI's per-user tool servers. Add the client's
  hostname to `ALLOWED_HOSTS`.

```sh
curl -H "Authorization: Bearer $ROOTRULES_TOKEN" "http://localhost:8787/api/search?q=ambush+defender"
```

- **Open WebUI:** add a tool server with URL `http://localhost:8787` and bearer auth.
- **Custom GPT:** Actions → Import from URL `https://rules.example.com/openapi.json`, authentication "API Key",
  type Bearer. This needs a public HTTPS URL.

### stdio (local)

For hosts that spawn the server themselves. Call `node` directly, not via `npm`, which writes to stdout:

```json
{ "mcpServers": { "root-rules": {
  "command": "node",
  "args": ["/path/to/rootrules/scripts/mcp-stdio.ts"]
} } }
```

Inspect either transport with `npx @modelcontextprotocol/inspector`.

## Chat app

[chat/](chat/) is a mobile-friendly chat UI (Go, single binary) that uses LM Studio and this server's MCP tools,
and can be served over Tailscale. See [chat/README.md](chat/README.md).

## Rule ids

Ids match the upstream site: sections are numbered, appendices are lettered (`G` = Glossary, so
upstream's numeric `21.24` is `G.24`). The printed Law writes the 4th/5th levels as roman numeral +
letter (`9.2.9.IIIa` = `9.2.9.3.1`). `normalizeRuleRef` in [src/ids.ts](src/ids.ts) accepts any of
these forms. Inline cross-references render as `§4.1.1 [Cost]`.

## Keyword index

Keywords are the terms the Law itself treats as terms, not every word. They come from:
- Glossary entries
- **bold** defined terms
- short concept headings (ability and action names)
- faction names
- items

Matching handles plurals and verb forms. Tune it in [src/keywords.ts](src/keywords.ts):
- `HEADING_STOPLIST` drops structural headings.
- `MENTION_EXCLUDES` filters everyday uses, e.g. "this rule" vs. ruling a clearing.

## Known upstream issues

Build warnings point at upstream data problems, e.g. `FAQ-3` cites `2.5.2`, which doesn't exist in p16.
