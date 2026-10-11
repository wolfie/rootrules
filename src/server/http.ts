import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createRootRulesServer, type LibraryProvider } from './mcp.ts';
import { handleApi, openApiDocument } from './rest.ts';

export interface HttpOptions {
  getLibrary: LibraryProvider;
  /** Directory of generated files (llms.txt, rules.md, ...) served as static content. */
  staticDir?: string;
  /** If set, every request except /healthz needs `Authorization: Bearer <token>`. */
  token?: string;
  /** Hostnames accepted in Host/Origin headers (DNS rebinding protection). */
  allowedHosts: string[];
  /** Base URL advertised in the OpenAPI spec; derived from the request if unset. */
  publicUrl?: string;
}

/** Base URL the client used, honouring a reverse proxy's X-Forwarded-* headers. */
function requestOrigin(req: IncomingMessage): string {
  const first = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h)?.split(',')[0]?.trim();
  const proto = first(req.headers['x-forwarded-proto']) ?? 'http';
  const host = first(req.headers['x-forwarded-host']) ?? req.headers.host ?? 'localhost';
  return `${proto}://${host}`;
}

const CONTENT_TYPES: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const digest = (s: string) => createHash('sha256').update(s).digest();

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return !!match && timingSafeEqual(digest(match[1]!.trim()), digest(token));
}

async function serveStatic(dir: string, pathname: string, req: IncomingMessage, res: ServerResponse) {
  const root = path.resolve(dir);
  const relative = decodeURIComponent(pathname === '/' ? '/llms.txt' : pathname);
  const file = path.resolve(root, `.${relative}`);
  const type = CONTENT_TYPES[path.extname(file)];
  if (!file.startsWith(root + path.sep) || !type) return notFound(res);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    notFound(res);
  }
}

function notFound(res: ServerResponse) {
  res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found\n');
}

export function createHttpServer(opts: HttpOptions): Server {
  const mcp = toNodeHandler(
    createMcpHandler(() => createRootRulesServer(opts.getLibrary), {
      onerror: (e) => console.error('root-rules: mcp error:', e.message),
    }),
  );
  const validateHost = hostHeaderValidation(opts.allowedHosts);
  const validateOrigin = originValidation(opts.allowedHosts);

  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;

    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok\n');
      return;
    }
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;

    // Browser-based OpenAPI clients (e.g. Open WebUI user tool servers) need CORS. Origins
    // already passed validation against ALLOWED_HOSTS above.
    const isApi = pathname === '/openapi.json' || pathname.startsWith('/api/');
    if (isApi && req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }
    }

    // The spec is public so clients can import it before credentials are configured.
    if (pathname === '/openapi.json') {
      const serverUrl = opts.publicUrl ?? requestOrigin(req);
      const body = JSON.stringify(openApiDocument(serverUrl, !!opts.token), null, 2);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(body);
      return;
    }

    if (opts.token && !authorized(req, opts.token)) {
      res.writeHead(401, { 'Content-Type': 'text/plain', 'WWW-Authenticate': 'Bearer' }).end('Unauthorized\n');
      return;
    }

    if (pathname.startsWith('/api/')) {
      if (!handleApi(opts.getLibrary, req, res, url)) notFound(res);
    } else if (pathname === '/mcp') {
      void mcp(req, res);
    } else if (opts.staticDir && (req.method === 'GET' || req.method === 'HEAD')) {
      void serveStatic(opts.staticDir, pathname, req, res);
    } else {
      notFound(res);
    }
  });
}
