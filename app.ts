// app.ts — the HTTP server: routing, auth, body reading, response writing.
//
// Routes:
//   GET  /healthz                       no auth, {ok: true}
//   POST /api/graphql                   GraphQL v4
//   POST /mcp                           Model Context Protocol (JSON-RPC 2.0)
//   DELETE /mcp                         200 (client close)
//   /api/v3/*                           REST v3
//   /{owner}/{repo}.git/info/refs      git smart-HTTP advertisement
//   /{owner}/{repo}.git/git-upload-pack
//   /{owner}/{repo}.git/git-receive-pack
//   everything else                     404 JSON {message}
//
// Auth: when MAKEFUN_SHOP_TOKEN is set and non-empty, the Authorization
// header must be exactly `Bearer <that token>`; otherwise any non-empty
// Bearer token is accepted. /healthz needs no auth. Every /api/v3 reply
// carries a non-empty X-GitHub-Request-Id.

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import type { RestReply } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePackEndpoint, handleUploadPack } from './gitproto.ts';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
let requestCounter = 0;
const requestIdPrefix = Math.random().toString(16).slice(2, 10);

function nextRequestId(): string {
  requestCounter += 1;
  return `req_${requestIdPrefix}_${requestCounter}`;
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function isAuthed(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (!token) return false;
  if (SHOP_TOKEN) return token === SHOP_TOKEN;
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'X-GitHub-Request-Id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export function createApp(): ReturnType<typeof createServer> {
  const store = new Store();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const method = req.method ?? 'GET';
      const path = url.pathname;
      const authed = isAuthed(req);

      // Health check: no auth.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // GraphQL v4.
      if (path === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (!authed) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        const result = handleGraphql(store, parsed.value);
        sendJson(res, result.status, result.body);
        return;
      }

      // MCP.
      if (path === '/mcp') {
        if (method === 'DELETE') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
          return;
        }
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const raw = await readBody(req);
        const reply = handleMcp(store, raw.toString('utf8'), authed);
        res.writeHead(reply.status, { 'Content-Type': reply.contentType });
        res.end(reply.body);
        return;
      }

      // REST v3.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const restPath = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
        const segments = restPath === '' ? [] : restPath.split('/').filter((s) => s.length > 0);
        const raw = await readBody(req);
        let body: unknown = null;
        if (raw.length > 0) {
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return;
          }
          body = parsed.value;
        }
        let reply: RestReply;
        try {
          reply = handleRest(store, {
            method,
            segments,
            query: url.searchParams,
            body,
            host: req.headers.host ?? '127.0.0.1',
            authed,
          });
        } catch (e) {
          // A handler bug must not take the server down.
          console.error('rest handler error', e);
          sendJson(res, 500, { message: 'Internal Server Error' });
          return;
        }
        if (reply.status === 204) {
          res.writeHead(204, { 'X-GitHub-Request-Id': nextRequestId() });
          res.end();
          return;
        }
        sendJson(res, reply.status, reply.body, reply.headers ?? {});
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/...
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
      if (gitMatch) {
        const owner = decodeURIComponent(gitMatch[1]);
        const repoName = decodeURIComponent(gitMatch[2]);
        const action = gitMatch[3];
        if (!authed) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const repo = store.getRepo(owner, repoName);
        if (action === 'info/refs') {
          const service = url.searchParams.get('service') ?? '';
          const gitProtocolVersion = headerValue(req.headers['git-protocol']);
          const reply = handleInfoRefs(repo, service, gitProtocolVersion);
          if (reply.status === 404) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          sendBuffer(res, reply.status, reply.body, reply.contentType);
          return;
        }
        if (action === 'git-upload-pack' && method === 'POST') {
          const raw = await readBody(req);
          const gitProtocolVersion = headerValue(req.headers['git-protocol']);
          const reply = handleUploadPack(repo, raw, gitProtocolVersion);
          if (reply.status === 404) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          sendBuffer(res, reply.status, reply.body, reply.contentType);
          return;
        }
        if (action === 'git-receive-pack' && method === 'POST') {
          const raw = await readBody(req);
          const reply = handleReceivePackEndpoint(repo, raw);
          if (reply.status === 404) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          sendBuffer(res, reply.status, reply.body, reply.contentType);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    } catch (e) {
      console.error('server error', e);
      if (!res.headersSent) {
        sendJson(res, 500, { message: 'Internal Server Error' });
      } else {
        res.end();
      }
    }
  });
  return server;
}

export { Store };
