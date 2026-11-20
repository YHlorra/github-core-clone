// The process's HTTP surface: one server that answers the health probe, the REST v3 API, the GraphQL
// v4 endpoint, the MCP endpoint and git's smart-HTTP protocol at `/{owner}/{repo}.git`.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ApiError, readBody, sendEmpty, sendJson } from './lib/http.ts';
import { Forge } from './lib/model.ts';
import { handleRest } from './lib/rest.ts';
import { handleGitHttp, parseGitPath } from './lib/githttp.ts';
import { handleGraphQL } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';

export interface RequestContext {
  forge: Forge;
  req: IncomingMessage;
  method: string;
  pathname: string;
  segments: string[];
  query: URLSearchParams;
  body: Buffer;
  baseUrl: string;
  authed: boolean;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function bearer(req: IncomingMessage): boolean {
  const value = req.headers.authorization;
  if (typeof value !== 'string') return false;
  const match = /^Bearer\s+(\S+)$/i.exec(value.trim());
  return match !== null && match[1] !== undefined && match[1] !== '';
}

async function dispatch(ctx: RequestContext, res: ServerResponse): Promise<void> {
  const { segments, method, pathname } = ctx;

  if (pathname === '/healthz' || pathname === '/healthz/') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (segments[0] === 'api' && segments[1] === 'v3') {
    const isRoot = segments.length === 2;
    if (!isRoot && !ctx.authed) {
      throw new ApiError(401, 'Requires authentication');
    }
    const result = handleRest({
      forge: ctx.forge,
      method,
      segments: segments.slice(2),
      query: ctx.query,
      body: ctx.body,
      baseUrl: ctx.baseUrl,
    });
    if (result.status === 204) {
      sendEmpty(res, 204, result.headers ?? {});
      return;
    }
    sendJson(res, result.status, result.body, result.headers ?? {});
    return;
  }

  if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
    if (!ctx.authed) throw new ApiError(401, 'Requires authentication');
    const result = handleGraphQL({ forge: ctx.forge, method, query: ctx.query, body: ctx.body, baseUrl: ctx.baseUrl });
    if (result.status === 204) {
      sendEmpty(res, 204, result.headers ?? {});
      return;
    }
    sendJson(res, result.status, result.body, result.headers ?? {});
    return;
  }

  if (segments[0] === 'mcp') {
    const result = handleMcp({
      forge: ctx.forge,
      method,
      segments: segments.slice(1),
      headers: ctx.req.headers,
      body: ctx.body,
      baseUrl: ctx.baseUrl,
      authed: ctx.authed,
    });
    if (result.status === 204) {
      sendEmpty(res, 204, result.headers ?? {});
      return;
    }
    if (result.raw !== undefined) {
      const payload = Buffer.from(result.raw, 'utf8');
      res.writeHead(result.status, {
        'content-type': result.contentType ?? 'application/json',
        'content-length': String(payload.length),
        ...result.headers,
      });
      res.end(payload);
      return;
    }
    sendJson(res, result.status, result.body, result.headers ?? {});
    return;
  }

  const git = parseGitPath(segments);
  if (git !== null) {
    const result = await handleGitHttp({
      forge: ctx.forge,
      method,
      owner: git.owner,
      repo: git.repo,
      rest: git.rest,
      query: ctx.query,
      body: ctx.body,
      baseUrl: ctx.baseUrl,
      authed: ctx.authed,
      protocolHeader: typeof ctx.req.headers['git-protocol'] === 'string' ? ctx.req.headers['git-protocol'] : undefined,
    });
    res.writeHead(result.status, {
      'content-type': result.contentType,
      'content-length': String(result.body.length),
      'cache-control': 'no-cache',
      ...result.headers,
    });
    res.end(result.body);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

export function createApp(): Server {
  const forge = new Forge();
  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const body = await readBody(req);
        const segments = url.pathname.split('/').filter((part) => part !== '').map(decodeSegment);
        await dispatch(
          {
            forge,
            req,
            method: (req.method ?? 'GET').toUpperCase(),
            pathname: url.pathname,
            segments,
            query: url.searchParams,
            body,
            baseUrl: `http://${req.headers.host ?? '127.0.0.1'}`,
            authed: bearer(req),
          },
          res,
        );
      } catch (error) {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (error instanceof ApiError) {
          sendJson(res, error.status, { message: error.message, ...error.extra });
          return;
        }
        const message = error instanceof Error ? error.message : 'Internal Server Error';
        sendJson(res, 500, { message });
      }
    })();
  });
}
