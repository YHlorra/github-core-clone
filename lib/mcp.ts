// The MCP endpoint: JSON-RPC 2.0 over streamable HTTP. The server negotiates the 2026-07-28 era through
// `server/discover` (and falls back to the `initialize` handshake), publishes one fixed tools list, and
// implements those tools over the same in-memory forge the REST surface serves.

import { ApiError } from './http.ts';
import { VIEWER, addIssue, addPull, isPull, mergePullRecord, type Forge, type Repo } from './model.ts';
import { issueJson, pullJson, repoJson, userJson } from './rest.ts';

export interface McpRequest {
  forge: Forge;
  method: string;
  /** Path segments after `/mcp`. */
  segments: string[];
  headers: import('node:http').IncomingHttpHeaders;
  body: Buffer;
  baseUrl: string;
  authed: boolean;
}

export interface McpResponse {
  status: number;
  body?: unknown;
  raw?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

const PROTOCOL_VERSION = '2026-07-28';
const SERVER_INFO = { name: 'ghclone', version: '1.0.0' } as const;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        owner: { type: 'string', description: 'Owner login; defaults to the authenticated user.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
        labels: { type: 'array', description: 'Label names to attach.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
        merge_method: { type: 'string', description: 'merge, squash or rebase.', enum: ['merge', 'squash', 'rebase'] },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

export function handleMcp(req: McpRequest): McpResponse {
  if (req.segments.length > 0) return { status: 404, body: { message: 'Not Found' } };
  if (req.method === 'DELETE') return { status: 204 };
  if (req.method === 'GET') return { status: 405, body: { message: 'Method Not Allowed' } };
  if (req.method !== 'POST') return { status: 405, body: { message: 'Method Not Allowed' } };
  if (!req.authed) return { status: 401, body: { message: 'Unauthorized' } };

  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      headers: { 'mcp-session-id': sessionId() },
    };
  }

  if (Array.isArray(parsed)) {
    const answers: unknown[] = [];
    for (const message of parsed) {
      const answer = answerOne(req, message);
      if (answer !== null) answers.push(answer);
    }
    if (answers.length === 0) return { status: 202 };
    return { status: 200, body: answers, headers: { 'mcp-session-id': sessionId() } };
  }

  const answer = answerOne(req, parsed);
  if (answer === null) return { status: 202, headers: { 'mcp-session-id': sessionId() } };
  return { status: 200, body: answer, headers: { 'mcp-session-id': sessionId() } };
}

let sessionCounter = 0;

function sessionId(): string {
  sessionCounter += 1;
  return `ghclone-session-${sessionCounter}`;
}

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function answerOne(req: McpRequest, message: unknown): unknown {
  if (typeof message !== 'object' || message === null) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const rpc = message as JsonRpcMessage;
  const id = rpc.id ?? null;
  const isNotification = rpc.id === undefined;
  const method = typeof rpc.method === 'string' ? rpc.method : '';
  const params = typeof rpc.params === 'object' && rpc.params !== null ? (rpc.params as Record<string, unknown>) : {};

  if (isNotification) return null;

  const reply = (result: unknown): unknown => ({ jsonrpc: '2.0', id, result });
  const error = (code: number, text: string): unknown => ({ jsonrpc: '2.0', id, error: { code, message: text } });

  switch (method) {
    case 'server/discover':
      return reply({
        supportedVersions: [PROTOCOL_VERSION],
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: { tools: { listChanged: false } },
      });
    case 'initialize':
      return reply({
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    case 'notifications/initialized':
      return null;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (tool === undefined) return error(-32602, `Unknown tool: ${name}`);
      const args = typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
      return reply(callTool(req.forge, tool, args));
    }
    default:
      return error(-32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------------------------
// argument handling

const OWNER_KEYS = ['owner', 'owner_login', 'organization', 'org', 'login'];
const REPO_KEYS = ['repo', 'repository', 'repo_name', 'repository_name', 'name'];
const NUMBER_KEYS = ['pull_number', 'pr_number', 'pull_request_number', 'number', 'issue_number'];
const HEAD_KEYS = ['head', 'head_ref', 'head_ref_name', 'head_branch', 'headBranch', 'headRefName'];
const BASE_KEYS = ['base', 'base_ref', 'base_ref_name', 'base_branch', 'baseBranch', 'baseRefName'];

function readString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function readNumber(args: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function readLabels(args: Record<string, unknown>): string[] {
  const raw = args.labels;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string');
}

function toolResult(payload: unknown, isError = false) {
  return {
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
    isError,
  };
}

interface ToolContext {
  forge: Forge;
  repo?: Repo;
}

function resolveRepo(forge: Forge, args: Record<string, unknown>): Repo | null {
  const owner = readString(args, OWNER_KEYS) ?? VIEWER.login;
  const name = readString(args, REPO_KEYS);
  if (name === undefined) return null;
  return forge.find(owner, name) ?? null;
}

function callTool(forge: Forge, tool: ToolDef, args: Record<string, unknown>) {
  switch (tool.name) {
    case 'create_repo': {
      const name = readString(args, REPO_KEYS);
      if (name === undefined) return toolResult('create_repo requires a repository name', true);
      const existing = forge.find(readString(args, OWNER_KEYS) ?? VIEWER.login, name);
      if (existing !== undefined) return toolResult(repoJson(existing, 'http://127.0.0.1'), false);
      const repo = forge.createRepo({
        name,
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
        owner: VIEWER.login,
      });
      return toolResult(repoJson(repo, 'http://127.0.0.1'));
    }
    case 'get_repo': {
      const repo = resolveRepo(forge, args);
      if (repo === null) return toolResult(`repository ${readString(args, OWNER_KEYS) ?? ''}/${readString(args, REPO_KEYS) ?? ''} was not found`, true);
      return toolResult(repoJson(repo, 'http://127.0.0.1'));
    }
    case 'create_issue': {
      const repo = resolveRepo(forge, args);
      if (repo === null) return toolResult('repository was not found', true);
      const title = readString(args, ['title']);
      if (title === undefined) return toolResult('create_issue requires a title', true);
      const issue = addIssue(forge, repo, {
        title,
        body: typeof args.body === 'string' ? args.body : '',
        labels: readLabels(args).map((name) => repo.labels.get(name)).filter((label): label is NonNullable<typeof label> => label !== undefined),
      });
      return toolResult(issueJson(issue, repo, 'http://127.0.0.1'));
    }
    case 'list_issues': {
      const repo = resolveRepo(forge, args);
      if (repo === null) return toolResult('repository was not found', true);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.threads.values()]
        .filter((thread) => !isPull(thread))
        .filter((thread) => state === 'all' || thread.state === state)
        .sort((a, b) => b.number - a.number)
        .map((thread) => issueJson(thread, repo, 'http://127.0.0.1'));
      return toolResult({ total_count: issues.length, issues });
    }
    case 'create_pull_request': {
      const repo = resolveRepo(forge, args);
      if (repo === null) return toolResult('repository was not found', true);
      const head = readString(args, HEAD_KEYS);
      const base = readString(args, BASE_KEYS) ?? repo.defaultBranch;
      if (head === undefined) return toolResult('create_pull_request requires a head branch', true);
      if (repo.refs.get(`refs/heads/${head}`) === undefined) return toolResult(`head branch ${head} does not exist`, true);
      const pull = addPull(forge, repo, {
        title: typeof args.title === 'string' ? args.title : `Merge ${head} into ${base}`,
        body: typeof args.body === 'string' ? args.body : '',
        head,
        base,
      });
      return toolResult(pullJson(pull, repo, 'http://127.0.0.1'));
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(forge, args);
      if (repo === null) return toolResult('repository was not found', true);
      const number = readNumber(args, NUMBER_KEYS);
      if (number === undefined) return toolResult('merge_pull_request requires a pull_number', true);
      const thread = repo.threads.get(number);
      if (thread === undefined || !isPull(thread)) return toolResult(`pull request #${number} was not found`, true);
      const outcome = mergePullRecord(repo, thread);
      if (!outcome.ok) return toolResult(outcome.reason ?? 'Pull Request is not mergeable', true);
      const json = pullJson(thread, repo, 'http://127.0.0.1');
      return toolResult({ ...json, merged: true, sha: outcome.sha });
    }
    default:
      return toolResult(`unknown tool ${tool.name}`, true);
  }
}

export { userJson };
