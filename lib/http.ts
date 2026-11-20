// The HTTP plumbing every surface shares: JSON replies shaped like GitHub's, request-body reading, and
// an error type the router turns into a JSON `{message}` response.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** A failure the API answers with `{message}` at `status`. */
export class ApiError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;

  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

let requestCounter = 0;

/** A request id the way GitHub mints one; only its presence and non-emptiness are observed. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `A1B2C3:${requestCounter.toString(16).toUpperCase()}:ghclone`;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': String(payload.length),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(payload);
}

export function sendEmpty(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-length': '0',
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end();
}

/** Read the whole request body. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body, answering 400 the way GitHub does when it is malformed. */
export function parseJsonBody(body: Buffer): unknown {
  const text = body.toString('utf8').trim();
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'Problems parsing JSON');
  }
}

/** `body` as an object, or 400 when the caller sent something else. */
export function objectBody(body: unknown): Record<string, unknown> {
  if (body === undefined) return {};
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(400, 'Problems parsing JSON');
  }
  return body as Record<string, unknown>;
}
