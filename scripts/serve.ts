// HTTP server, all on one port:
//   /mcp            MCP (Streamable HTTP)
//   /api/*          the same lookups as REST/JSON, described by /openapi.json
//   /, /rules.md …  the generated dist/ files (/ is llms.txt)
// Reloads dist/rulebook.json after `npm run update`.
//
// Environment:
//   PORT              default 8787
//   HOST              default 127.0.0.1 (put a TLS reverse proxy in front for remote use)
//   ROOTRULES_TOKEN   bearer token required on every request; mandatory unless HOST is loopback
//   ALLOWED_HOSTS     comma-separated hostnames clients use to reach the server
//                     (default localhost,127.0.0.1,[::1]); add your public hostname
//   ROOTRULES_DIST    directory with the built files, default ./dist
//   PUBLIC_URL        base URL put in /openapi.json, e.g. https://rules.example.com
//                     (default: derived from the request and X-Forwarded-* headers)

import path from 'node:path';
import { createHttpServer } from '../src/server/http.ts';
import { RulebookStore } from '../src/server/store.ts';
import { PROJECT_ROOT } from '../src/snapshot.ts';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
const token = process.env.ROOTRULES_TOKEN || undefined;
const dist = path.resolve(process.env.ROOTRULES_DIST ?? path.join(PROJECT_ROOT, 'dist'));
const publicUrl = process.env.PUBLIC_URL?.replace(/\/+$/, '') || undefined;
const allowedHosts = (process.env.ALLOWED_HOSTS ?? 'localhost,127.0.0.1,[::1]')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
if (!token && !loopback) {
  console.error(`Refusing to listen on ${host} without ROOTRULES_TOKEN. Set a token, or bind to 127.0.0.1 behind a proxy that authenticates.`);
  process.exit(1);
}

const store = new RulebookStore(path.join(dist, 'rulebook.json'));
store.get(); // fail fast if there is no data yet

createHttpServer({ getLibrary: () => store.get(), staticDir: dist, token, allowedHosts, publicUrl }).listen(port, host, () => {
  const base = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  console.error(`root-rules: MCP ${base}/mcp, OpenAPI ${base}/openapi.json (auth: ${token ? 'bearer token' : 'none'})`);
});
