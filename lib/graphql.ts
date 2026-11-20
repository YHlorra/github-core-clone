// The GraphQL v4 endpoint. A small document parser (operations, variables, aliases, inline fragments,
// enum and object literals) feeds an executor whose resolvers read the same in-memory forge that REST
// serves, so `gh`'s documents and its `__type` feature probes answer from one source of truth.

import { ApiError } from './http.ts';
import {
  VIEWER,
  addComment,
  addIssue,
  addPull,
  branchTip,
  commitFiles,
  diffTrees,
  isPull,
  mergeBase,
  mergePullRecord,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
  type Thread,
} from './model.ts';

export interface GraphQLRequest {
  forge: Forge;
  method: string;
  query: URLSearchParams;
  body: Buffer;
  baseUrl: string;
}

export interface GraphQLResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface GraphQLPayload {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

export function handleGraphQL(req: GraphQLRequest): GraphQLResult {
  let payload: unknown;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    throw new ApiError(400, 'Problems parsing JSON');
  }
  const responses = Array.isArray(payload)
    ? payload.map((entry) => executeOne(req.forge, entry))
    : executeOne(req.forge, payload);
  return { status: 200, body: responses };
}

function executeOne(forge: Forge, raw: unknown): Record<string, unknown> {
  const payload = typeof raw === 'object' && raw !== null ? (raw as GraphQLPayload) : {};
  const document = typeof payload.query === 'string' ? payload.query : '';
  const variables = typeof payload.variables === 'object' && payload.variables !== null ? (payload.variables as Record<string, unknown>) : {};
  const operationName = typeof payload.operationName === 'string' ? payload.operationName : undefined;

  let operation: Operation;
  try {
    const parsed = parseDocument(document);
    const chosen = operationName === undefined ? parsed[0] : parsed.find((entry) => entry.name === operationName) ?? parsed[0];
    if (chosen === undefined) return { errors: [{ message: 'the document holds no operation' }] };
    operation = chosen;
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'the document could not be parsed' }] };
  }

  const errors: { message: string; path: (string | number)[] }[] = [];
  const scoped = resolveVariables(operation, variables);
  const root = executeSelectionSet(operation.kind === 'mutation' ? 'Mutation' : 'Query', null, operation.selections, forge, scoped, errors);
  const body: Record<string, unknown> = { data: root };
  if (errors.length > 0) body.errors = errors;
  return body;
}

function resolveVariables(operation: Operation, provided: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...provided };
  for (const def of operation.variableDefs) {
    if (out[def.name] === undefined && def.defaultValue !== undefined) out[def.name] = literalValue(def.defaultValue, {});
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// document parsing

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  alias: string;
  name: string;
  args: Record<string, ValueNode>;
  selections: SelectionNode[];
}

interface InlineFragment {
  kind: 'inline';
  typeCondition: string | null;
  selections: SelectionNode[];
}

interface FragmentSpread {
  kind: 'spread';
  name: string;
}

type SelectionNode = FieldNode | InlineFragment | FragmentSpread;

interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  variableDefs: { name: string; defaultValue?: ValueNode }[];
  selections: SelectionNode[];
}

class Tokenizer {
  private readonly text: string;
  private index = 0;

  constructor(text: string) {
    this.text = text;
  }

  eof(): boolean {
    return this.peek() === '';
  }

  peek(): string {
    while (this.index < this.text.length) {
      const ch = this.text[this.index]!;
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\ufeff') {
        this.index += 1;
        continue;
      }
      if (ch === '#') {
        while (this.index < this.text.length && this.text[this.index] !== '\n') this.index += 1;
        continue;
      }
      return ch;
    }
    return '';
  }

  take(): string {
    const ch = this.peek();
    if (ch !== '') this.index += 1;
    return ch;
  }

  match(text: string): boolean {
    this.peek();
    if (this.text.startsWith(text, this.index)) {
      this.index += text.length;
      return true;
    }
    return false;
  }

  name(): string {
    this.peek();
    const start = this.index;
    while (this.index < this.text.length && /[A-Za-z0-9_]/.test(this.text[this.index]!)) this.index += 1;
    if (start === this.index) throw new Error(`expected a name at offset ${start}`);
    return this.text.slice(start, this.index);
  }

  string(): string {
    const quote = this.take();
    let out = '';
    for (;;) {
      const ch = this.take();
      if (ch === '' || ch === quote) break;
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      const next = this.take();
      if (next === 'n') out += '\n';
      else if (next === 't') out += '\t';
      else if (next === 'r') out += '\r';
      else if (next === 'u') {
        out += String.fromCharCode(Number.parseInt(this.text.slice(this.index, this.index + 4), 16));
        this.index += 4;
      } else out += next;
    }
    return out;
  }

  number(): number {
    this.peek();
    const start = this.index;
    while (this.index < this.text.length && /[-+0-9.eE]/.test(this.text[this.index]!)) this.index += 1;
    return Number(this.text.slice(start, this.index));
  }
}

function parseDocument(text: string): Operation[] {
  const tokens = new Tokenizer(text);
  const operations: Operation[] = [];
  while (!tokens.eof()) {
    if (tokens.peek() === '{') {
      operations.push({ kind: 'query', variableDefs: [], selections: parseSelectionSet(tokens) });
      continue;
    }
    const keyword = tokens.name();
    if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') {
      throw new Error(`unexpected "${keyword}" at the top of the document`);
    }
    const kind = keyword === 'mutation' ? 'mutation' : 'query';
    let name: string | undefined;
    if (tokens.peek() !== '(' && tokens.peek() !== '{') name = tokens.name();
    const variableDefs: { name: string; defaultValue?: ValueNode }[] = [];
    if (tokens.peek() === '(') {
      tokens.take();
      while (!tokens.eof() && tokens.peek() !== ')') {
        if (tokens.peek() === '$') tokens.take();
        const variableName = tokens.name();
        tokens.take();
        skipType(tokens);
        let defaultValue: ValueNode | undefined;
        if (tokens.peek() === '=') {
          tokens.take();
          defaultValue = parseValue(tokens);
        }
        variableDefs.push({ name: variableName, defaultValue });
        while (tokens.peek() === '@') {
          tokens.take();
          tokens.name();
          if (tokens.peek() === '(') skipBalanced(tokens, '(', ')');
        }
      }
      if (tokens.peek() === ')') tokens.take();
    }
    while (tokens.peek() === '@') {
      tokens.take();
      tokens.name();
      if (tokens.peek() === '(') skipBalanced(tokens, '(', ')');
    }
    operations.push({ kind, name, variableDefs, selections: parseSelectionSet(tokens) });
  }
  return operations;
}

function skipType(tokens: Tokenizer): void {
  if (tokens.peek() === '[') {
    tokens.take();
    skipType(tokens);
    if (tokens.peek() === ']') tokens.take();
  } else {
    tokens.name();
  }
  while (tokens.peek() === '!') tokens.take();
}

function skipBalanced(tokens: Tokenizer, open: string, close: string): void {
  if (tokens.peek() !== open) return;
  tokens.take();
  let depth = 1;
  while (!tokens.eof() && depth > 0) {
    const ch = tokens.take();
    if (ch === open) depth += 1;
    else if (ch === close) depth -= 1;
  }
}

function parseSelectionSet(tokens: Tokenizer): SelectionNode[] {
  if (tokens.peek() !== '{') throw new Error('expected a selection set');
  tokens.take();
  const selections: SelectionNode[] = [];
  while (!tokens.eof() && tokens.peek() !== '}') {
    if (tokens.match('...')) {
      if (tokens.peek() === 'o') {
        tokens.name();
        const typeCondition = tokens.name();
        selections.push({ kind: 'inline', typeCondition, selections: parseSelectionSet(tokens) });
        continue;
      }
      selections.push({ kind: 'spread', name: tokens.name() });
      continue;
    }
    const first = tokens.name();
    let alias = first;
    let name = first;
    if (tokens.peek() === ':') {
      tokens.take();
      name = tokens.name();
    }
    const args: Record<string, ValueNode> = {};
    if (tokens.peek() === '(') {
      tokens.take();
      while (!tokens.eof() && tokens.peek() !== ')') {
        const argName = tokens.name();
        tokens.take();
        args[argName] = parseValue(tokens);
      }
      if (tokens.peek() === ')') tokens.take();
    }
    while (tokens.peek() === '@') {
      tokens.take();
      tokens.name();
      if (tokens.peek() === '(') skipBalanced(tokens, '(', ')');
    }
    const inner = tokens.peek() === '{' ? parseSelectionSet(tokens) : [];
    selections.push({ kind: 'field', alias, name, args, selections: inner });
  }
  if (tokens.peek() === '}') tokens.take();
  return selections;
}

function parseValue(tokens: Tokenizer): ValueNode {
  const ch = tokens.peek();
  if (ch === '$') {
    tokens.take();
    return { kind: 'variable', name: tokens.name() };
  }
  if (ch === '"') return { kind: 'string', value: tokens.string() };
  if (ch === '[') {
    tokens.take();
    const values: ValueNode[] = [];
    while (!tokens.eof() && tokens.peek() !== ']') values.push(parseValue(tokens));
    if (tokens.peek() === ']') tokens.take();
    return { kind: 'list', values };
  }
  if (ch === '{') {
    tokens.take();
    const fields: Record<string, ValueNode> = {};
    while (!tokens.eof() && tokens.peek() !== '}') {
      const name = tokens.name();
      tokens.take();
      fields[name] = parseValue(tokens);
    }
    if (tokens.peek() === '}') tokens.take();
    return { kind: 'object', fields };
  }
  if (ch === '-' || /[0-9]/.test(ch)) return { kind: 'number', value: tokens.number() };
  const word = tokens.name();
  if (word === 'true' || word === 'false') return { kind: 'boolean', value: word === 'true' };
  if (word === 'null') return { kind: 'null' };
  return { kind: 'enum', value: word };
}

function literalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'enum':
    case 'number':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => literalValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = literalValue(value, variables);
      return out;
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// execution

interface Resolved {
  typename: string;
  value: unknown;
}

const NONE: Resolved = { typename: 'None', value: null };

function executeSelectionSet(
  typename: string,
  parent: unknown,
  selections: SelectionNode[],
  forge: Forge,
  variables: Record<string, unknown>,
  errors: { message: string; path: (string | number)[] }[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      const applies = selection.typeCondition === null || selection.typeCondition === typename;
      if (!applies) continue;
      Object.assign(out, executeSelectionSet(typename, parent, selection.selections, forge, variables, errors));
      continue;
    }
    if (selection.kind === 'spread') continue;
    if (selection.name === '__typename') {
      out[selection.alias] = typename;
      continue;
    }
    let resolved: Resolved;
    try {
      const args: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(selection.args)) args[key] = literalValue(value, variables);
      resolved = resolveField(typename, parent, selection.name, args, forge);
    } catch (error) {
      errors.push({ message: error instanceof Error ? error.message : String(error), path: [selection.alias] });
      continue;
    }
    if (resolved.value === null || resolved.value === undefined) {
      out[selection.alias] = null;
      continue;
    }
    if (selection.selections.length === 0) {
      out[selection.alias] = resolved.value;
      continue;
    }
    const child = resolved.value as Record<string, unknown>;
    if (Array.isArray(resolved.value)) {
      out[selection.alias] = resolved.value.map((entry) => {
        const item = entry as { __typename?: string; parent?: unknown };
        const itemType = typeof item.__typename === 'string' ? item.__typename : resolved.typename;
        const parentValue = item.parent === undefined ? entry : item.parent;
        return executeSelectionSet(itemType, parentValue, selection.selections, forge, variables, errors);
      });
      continue;
    }
    out[selection.alias] = executeSelectionSet(resolved.typename, child.parent ?? child, selection.selections, forge, variables, errors);
  }
  return out;
}

function unknown(typename: string, field: string): Error {
  return new Error(`Field "${field}" is not defined on type "${typename}"`);
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function node(kind: string, value: unknown): Resolved {
  if (value === null || value === undefined) return NONE;
  return { typename: kind, value: { parent: value, __typename: kind, value } };
}

function scalar(value: unknown): Resolved {
  return { typename: 'String', value: value === undefined ? null : value };
}

function resolveField(typename: string, parent: unknown, field: string, args: Record<string, unknown>, forge: Forge): Resolved {
  if (field === '__typename') return scalar(typename);
  if (typename === 'Query') return resolveQuery(parent, field, args, forge);
  if (typename === 'Mutation') return resolveMutation(parent, field, args, forge);
  if (typename === 'Repository') return resolveRepository(parent as Repo, field, args, forge);
  if (typename === 'Issue') return resolveIssue(parent as { issue: Issue; repo: Repo }, field, args, forge);
  if (typename === 'PullRequest') return resolvePull(parent as { pull: Pull; repo: Repo }, field, args, forge);
  if (typename === 'User') return resolveUser(field);
  if (typename === 'CreateIssuePayload' || typename === 'CloseIssuePayload') return resolveIssuePayload(parent, field);
  if (typename === 'CreatePullRequestPayload' || typename === 'MergePullRequestPayload') return resolvePullPayload(parent, field);
  if (typename === 'AddCommentPayload') return resolveCommentPayload(parent, field);
  if (typename === 'IssueCommentEdge') {
    if (field === 'node') return node('IssueComment', (parent as { comment?: unknown }).comment ?? null);
    if (field === 'cursor') return scalar('Y3Vyc29yOjA=');
    throw unknown(typename, field);
  }
  if (typename === 'IssueConnection' || typename === 'PullRequestConnection') return resolveConnection(parent, field, args);
  if (typename === 'PageInfo') return scalar((parent as Record<string, unknown>)[field] ?? null);
  if (typename === 'PullRequestChangedFile') return resolveChangedFile(parent as { path: string }, field, args);
  if (typename === 'Label') return scalar(field === 'name' ? (parent as { name: string }).name : null);
  if (typename === 'BranchRef') return scalar(field === 'name' ? (parent as { name: string }).name : field === 'target' ? null : null);
  if (typename === 'IssueComment') return resolveComment(parent as { id: number; body: string }, field);
  if (typename === 'Type') return resolveType(parent as TypeDescriptor, field, args);
  if (typename === 'TypeField') return resolveTypeField(parent as TypeFieldDescriptor, field, args);
  if (typename === 'EnumValue') return scalar((parent as { name: string; description: string })[field as 'name' | 'description'] ?? null);
  if (typename === 'Schema') return scalar(null);
  if (typename === 'MergeCommit') return scalar(null);
  throw unknown(typename, field);
}

function resolveQuery(parent: unknown, field: string, args: Record<string, unknown>, forge: Forge): Resolved {
  void parent;
  switch (field) {
    case 'viewer':
      return node('User', VIEWER);
    case 'repository': {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = forge.find(owner, name);
      return repo === undefined ? NONE : node('Repository', repo);
    }
    case 'node': {
      return resolveNode(typeof args.id === 'string' ? args.id : '', forge);
    }
    case '__type': {
      const descriptor = typeDescriptor(typeof args.name === 'string' ? args.name : '');
      return descriptor === null ? NONE : node('Type', descriptor);
    }
    case 'search': {
      return node('SearchResultConnection', { nodes: [], pageInfo: { hasNextPage: false, endCursor: null }, totalCount: 0 });
    }
    default:
      throw unknown('Query', field);
  }
}

function resolveNode(id: string, forge: Forge): Resolved {
  if (id.startsWith('R_')) {
    const repoId = Number(id.slice(2));
    for (const repo of forge.repos.values()) if (repo.id === repoId) return node('Repository', repo);
    return NONE;
  }
  if (id.startsWith('I_')) {
    const [, repoIdText, numberText] = id.split('_');
    const repo = [...forge.repos.values()].find((candidate) => candidate.id === Number(repoIdText));
    const thread = repo?.threads.get(Number(numberText));
    if (repo === undefined || thread === undefined) return NONE;
    return node('Issue', { issue: thread as Issue, repo });
  }
  if (id.startsWith('P_')) {
    const [, repoIdText, numberText] = id.split('_');
    const repo = [...forge.repos.values()].find((candidate) => candidate.id === Number(repoIdText));
    const thread = repo?.threads.get(Number(numberText));
    if (repo === undefined || thread === undefined || !isPull(thread)) return NONE;
    return node('PullRequest', { pull: thread, repo });
  }
  return NONE;
}

function resolveRepository(repo: Repo, field: string, args: Record<string, unknown>, forge: Forge): Resolved {
  void forge;
  switch (field) {
    case 'id':
      return scalar(`R_${repo.id}`);
    case 'databaseId':
      return scalar(repo.id);
    case 'name':
      return scalar(repo.name);
    case 'nameWithOwner':
      return scalar(`${repo.owner}/${repo.name}`);
    case 'owner':
      return node('User', VIEWER);
    case 'description':
      return scalar(repo.description);
    case 'isPrivate':
      return scalar(repo.private);
    case 'visibility':
      return scalar(repo.private ? 'PRIVATE' : 'PUBLIC');
    case 'defaultBranchRef':
      return node('BranchRef', { name: repo.defaultBranch });
    case 'viewerPermission':
      return scalar('ADMIN');
    case 'hasIssuesEnabled':
      return scalar(true);
    case 'hasWikiEnabled':
    case 'hasProjectsEnabled':
    case 'isFork':
    case 'isArchived':
    case 'isDisabled':
    case 'isTemplate':
      return scalar(false);
    case 'createdAt':
      return scalar(repo.createdAt);
    case 'updatedAt':
      return scalar(repo.updatedAt);
    case 'pushedAt':
      return scalar(repo.pushedAt);
    case 'url':
      return scalar(`http://github.local/${repo.owner}/${repo.name}`);
    case 'sshUrl':
      return scalar(`git@github.local:${repo.owner}/${repo.name}.git`);
    case 'stargazerCount':
    case 'forkCount':
    case 'diskUsage':
    case 'watchers':
      return scalar(0);
    case 'primaryLanguage':
    case 'licenseInfo':
    case 'parent':
    case 'object':
    case 'ref':
    case 'milestone':
      return scalar(null);
    case 'repositoryTopics':
      return node('IssueConnection', { nodes: [], pageInfo: { hasNextPage: false, endCursor: null }, totalCount: 0 });
    case 'labels':
      return node('IssueConnection', { nodes: [], pageInfo: { hasNextPage: false, endCursor: null }, totalCount: 0 });
    case 'issue': {
      const number = asNumber(args.number, 0);
      const thread = repo.threads.get(number);
      if (thread === undefined || isPull(thread)) return NONE;
      return node('Issue', { issue: thread, repo });
    }
    case 'issues': {
      const issues = [...repo.threads.values()].filter((thread): thread is Issue => !isPull(thread));
      return node('IssueConnection', issueConnection(repo, issues, args));
    }
    case 'pullRequests': {
      const pulls = [...repo.threads.values()].filter((thread): thread is Pull => isPull(thread));
      return node('PullRequestConnection', pullConnection(repo, pulls, args));
    }
    case 'pullRequest': {
      const number = asNumber(args.number, 0);
      const thread = repo.threads.get(number);
      if (thread === undefined || !isPull(thread)) return NONE;
      return node('PullRequest', { pull: thread, repo });
    }
    default:
      throw unknown('Repository', field);
  }
}

function resolveIssue(parent: { issue: Issue; repo: Repo }, field: string, args: Record<string, unknown>, forge: Forge): Resolved {
  const issue = parent.issue;
  void args;
  void forge;
  switch (field) {
    case 'id':
      return scalar(`I_${parent.repo.id}_${issue.number}`);
    case 'number':
      return scalar(issue.number);
    case 'title':
      return scalar(issue.title);
    case 'body':
      return scalar(issue.body);
    case 'state':
      return scalar(issue.state === 'open' ? 'OPEN' : 'CLOSED');
    case 'stateReason':
      return scalar(issue.state === 'open' ? null : 'COMPLETED');
    case 'createdAt':
      return scalar(issue.createdAt);
    case 'updatedAt':
      return scalar(issue.updatedAt);
    case 'closed':
      return scalar(issue.state === 'closed');
    case 'closedAt':
      return scalar(issue.closedAt);
    case 'author':
      return node('User', VIEWER);
    case 'repository':
      return node('Repository', parent.repo);
    case 'url':
      return scalar(`http://github.local/${parent.repo.owner}/${parent.repo.name}/issues/${issue.number}`);
    case 'labels':
      return node('IssueConnection', {
        nodes: issue.labels.map((label) => ({ ...label, __typename: 'Label' })),
        pageInfo: { hasNextPage: false, endCursor: null },
        totalCount: issue.labels.length,
      });
    case 'comments':
      return node('IssueConnection', {
        nodes: issue.comments.map((comment) => ({ ...comment, __typename: 'IssueComment' })),
        pageInfo: { hasNextPage: false, endCursor: null },
        totalCount: issue.comments.length,
      });
    default:
      throw unknown('Issue', field);
  }
}

function resolvePull(parent: { pull: Pull; repo: Repo }, field: string, args: Record<string, unknown>, forge: Forge): Resolved {
  const pull = parent.pull;
  void forge;
  switch (field) {
    case 'id':
      return scalar(`P_${parent.repo.id}_${pull.number}`);
    case 'number':
      return scalar(pull.number);
    case 'title':
      return scalar(pull.title);
    case 'body':
      return scalar(pull.body);
    case 'state':
      return scalar(pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED');
    case 'merged':
      return scalar(pull.merged);
    case 'mergedAt':
      return scalar(pull.mergedAt);
    case 'mergeCommit':
      return scalar(pull.mergeCommitSha === null ? null : null);
    case 'mergeCommitSha':
      return scalar(pull.mergeCommitSha);
    case 'closed':
      return scalar(pull.state === 'closed');
    case 'closedAt':
      return scalar(pull.closedAt);
    case 'createdAt':
      return scalar(pull.createdAt);
    case 'updatedAt':
      return scalar(pull.updatedAt);
    case 'isDraft':
      return scalar(false);
    case 'headRefName':
      return scalar(pull.head);
    case 'baseRefName':
      return scalar(pull.base);
    case 'headRefOid':
      return scalar(branchTip(parent.repo, pull.head) ?? '');
    case 'baseRefOid':
      return scalar(branchTip(parent.repo, pull.base) ?? '');
    case 'mergeable':
      return scalar('MERGEABLE');
    case 'mergeStateStatus':
      return scalar('CLEAN');
    case 'reviewDecision':
      return scalar(null);
    case 'changedFiles':
      return scalar(changedFiles(parent.repo, pull).length);
    case 'additions':
      return scalar(changedFiles(parent.repo, pull).reduce((total, entry) => total + entry.additions, 0));
    case 'deletions':
      return scalar(changedFiles(parent.repo, pull).reduce((total, entry) => total + entry.deletions, 0));
    case 'files': {
      const files = changedFiles(parent.repo, pull);
      const first = asNumber(args.first, 30);
      return node('IssueConnection', {
        nodes: files.slice(0, first).map((entry) => ({ ...entry, __typename: 'PullRequestChangedFile' })),
        pageInfo: { hasNextPage: false, endCursor: null },
        totalCount: files.length,
      });
    }
    case 'author':
      return node('User', VIEWER);
    case 'repository':
      return node('Repository', parent.repo);
    case 'headRepository':
    case 'baseRepository':
      return node('Repository', parent.repo);
    case 'url':
      return scalar(`http://github.local/${parent.repo.owner}/${parent.repo.name}/pull/${pull.number}`);
    case 'comments':
      return node('IssueConnection', {
        nodes: pull.comments.map((comment) => ({ ...comment, __typename: 'IssueComment' })),
        pageInfo: { hasNextPage: false, endCursor: null },
        totalCount: pull.comments.length,
      });
    case 'commits':
      return node('IssueConnection', { nodes: [], pageInfo: { hasNextPage: false, endCursor: null }, totalCount: 0 });
    default:
      throw unknown('PullRequest', field);
  }
}

function changedFiles(repo: Repo, pull: Pull): { path: string; additions: number; deletions: number; changeType: string }[] {
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (headTip === undefined) return [];
  const head = commitFiles(repo, headTip);
  const base = baseTip === undefined ? undefined : mergeBase(repo, baseTip, headTip);
  const ancestor = base === undefined ? new Map<string, { mode: string; oid: string }>() : commitFiles(repo, base);
  return diffTrees(repo, ancestor, head).map((entry) => ({
    path: entry.filename,
    additions: entry.additions,
    deletions: entry.deletions,
    changeType: entry.status === 'added' ? 'ADDED' : entry.status === 'removed' ? 'DELETED' : 'MODIFIED',
  }));
}

function resolveConnection(parent: unknown, field: string, args: Record<string, unknown>): Resolved {
  void args;
  const connection = parent as { nodes?: unknown[]; pageInfo?: Record<string, unknown>; totalCount?: number };
  switch (field) {
    case 'nodes':
      return { typename: 'Node', value: connection.nodes ?? [] };
    case 'pageInfo':
      return node('PageInfo', connection.pageInfo ?? { hasNextPage: false, endCursor: null });
    case 'totalCount':
      return scalar(connection.totalCount ?? 0);
    case 'edges':
      return scalar([]);
    default:
      throw unknown('Connection', field);
  }
}

function resolveChangedFile(parent: { path: string }, field: string, args: Record<string, unknown>): Resolved {
  void args;
  const entry = parent as unknown as { path: string; additions: number; deletions: number; changeType: string };
  switch (field) {
    case 'path':
      return scalar(entry.path);
    case 'additions':
      return scalar(entry.additions ?? 0);
    case 'deletions':
      return scalar(entry.deletions ?? 0);
    case 'changeType':
      return scalar(entry.changeType ?? 'MODIFIED');
    default:
      throw unknown('PullRequestChangedFile', field);
  }
}

function resolveComment(parent: { id: number; body: string }, field: string): Resolved {
  switch (field) {
    case 'id':
      return scalar(`C_${parent.id}`);
    case 'body':
      return scalar(parent.body);
    default:
      throw unknown('IssueComment', field);
  }
}

function resolveUser(field: string): Resolved {
  switch (field) {
    case 'id':
      return scalar(`U_${VIEWER.id}`);
    case 'login':
      return scalar(VIEWER.login);
    case 'name':
      return scalar(VIEWER.name);
    case 'email':
      return scalar(VIEWER.email);
    case 'avatarUrl':
      return scalar(`http://github.local/${VIEWER.login}.png`);
    case 'url':
      return scalar(`http://github.local/${VIEWER.login}`);
    default:
      throw unknown('User', field);
  }
}

function resolveIssuePayload(parent: unknown, field: string): Resolved {
  if (field === 'clientMutationId') return scalar(null);
  if (field !== 'issue') throw unknown('CreateIssuePayload', field);
  const value = (parent as { issue?: { issue: Issue; repo: Repo } }).issue;
  return value === undefined ? NONE : node('Issue', value);
}

function resolvePullPayload(parent: unknown, field: string): Resolved {
  if (field === 'clientMutationId') return scalar(null);
  if (field !== 'pullRequest') throw unknown('CreatePullRequestPayload', field);
  const value = (parent as { pull?: { pull: Pull; repo: Repo } }).pull;
  return value === undefined ? NONE : node('PullRequest', value);
}

function resolveCommentPayload(parent: unknown, field: string): Resolved {
  if (field === 'clientMutationId') return scalar(null);
  if (field !== 'commentEdge') throw unknown('AddCommentPayload', field);
  const value = (parent as { comment?: unknown }).comment;
  return value === undefined ? NONE : node('IssueCommentEdge', { comment: value });
}

// ---------------------------------------------------------------------------------------------
// connections

function issueConnection(repo: Repo, issues: Issue[], args: Record<string, unknown>): Record<string, unknown> {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  let list = issues;
  if (states !== null && states.length > 0) list = list.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  const orderBy = typeof args.orderBy === 'object' && args.orderBy !== null ? (args.orderBy as { field?: string; direction?: string }) : {};
  const direction = orderBy.direction === 'ASC' ? 1 : -1;
  const field = orderBy.field ?? 'CREATED_AT';
  list = [...list].sort((a, b) => {
    let delta: number;
    if (field === 'UPDATED_AT') delta = Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
    else if (field === 'COMMENTS') delta = a.comments.length - b.comments.length;
    else delta = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (delta === 0) delta = a.number - b.number;
    return direction * delta;
  });
  const first = Math.max(0, asNumber(args.first, 30));
  const offset = decodeCursor(args.after);
  const slice = list.slice(offset, offset + first);
  return {
    nodes: slice.map((issue) => ({ parent: { issue, repo }, __typename: 'Issue' })),
    pageInfo: {
      hasNextPage: offset + slice.length < list.length,
      hasPreviousPage: offset > 0,
      startCursor: slice.length > 0 ? encodeCursor(offset) : null,
      endCursor: slice.length > 0 ? encodeCursor(offset + slice.length) : null,
    },
    totalCount: list.length,
  };
}

function pullConnection(repo: Repo, pulls: Pull[], args: Record<string, unknown>): Record<string, unknown> {
  const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
  let list = pulls;
  if (states.length > 0) {
    list = list.filter((pull) => {
      const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      return states.includes(state);
    });
  }
  list = [...list].sort((a, b) => b.number - a.number);
  const first = Math.max(0, asNumber(args.first, 30));
  const offset = decodeCursor(args.after);
  const slice = list.slice(offset, offset + first);
  return {
    nodes: slice.map((pull) => ({ parent: { pull, repo }, __typename: 'PullRequest' })),
    pageInfo: {
      hasNextPage: offset + slice.length < list.length,
      hasPreviousPage: offset > 0,
      startCursor: slice.length > 0 ? encodeCursor(offset) : null,
      endCursor: slice.length > 0 ? encodeCursor(offset + slice.length) : null,
    },
    totalCount: list.length,
  };
}

function encodeCursor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64');
}

function decodeCursor(value: unknown): number {
  if (typeof value !== 'string' || value === '') return 0;
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match === null ? 0 : Number(match[1]);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------------------------
// mutations

function resolveMutation(parent: unknown, field: string, args: Record<string, unknown>, forge: Forge): Resolved {
  void parent;
  const input = typeof args.input === 'object' && args.input !== null ? (args.input as Record<string, unknown>) : {};
  switch (field) {
    case 'createIssue': {
      const repo = repoById(forge, typeof input.repositoryId === 'string' ? input.repositoryId : '');
      if (repo === null) return NONE;
      const issue = addIssue(forge, repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
      });
      return node('CreateIssuePayload', { issue: { issue, repo } });
    }
    case 'closeIssue': {
      const found = threadById(forge, typeof input.issueId === 'string' ? input.issueId : '');
      if (found === null) return NONE;
      const thread = found.thread;
      if (thread.state !== 'closed') {
        thread.state = 'closed';
        thread.closedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      }
      return node('CloseIssuePayload', { issue: { issue: thread as Issue, repo: found.repo } });
    }
    case 'createPullRequest': {
      const repo = repoById(forge, typeof input.repositoryId === 'string' ? input.repositoryId : '');
      if (repo === null) return NONE;
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
      if (repo.refs.get(`refs/heads/${head}`) === undefined) return NONE;
      const pull = addPull(forge, repo, {
        title: typeof input.title === 'string' ? input.title : `Merge ${head}`,
        body: typeof input.body === 'string' ? input.body : '',
        head,
        base,
      });
      return node('CreatePullRequestPayload', { pull: { pull, repo } });
    }
    case 'mergePullRequest': {
      const found = threadById(forge, typeof input.pullRequestId === 'string' ? input.pullRequestId : '');
      if (found === null || !isPull(found.thread)) return NONE;
      const outcome = mergePullRecord(found.repo, found.thread);
      if (!outcome.ok) return NONE;
      return node('MergePullRequestPayload', { pull: { pull: found.thread, repo: found.repo } });
    }
    case 'addComment': {
      const found = threadById(forge, typeof input.subjectId === 'string' ? input.subjectId : '');
      if (found === null) return NONE;
      const comment = addComment(forge, found.repo, found.thread, typeof input.body === 'string' ? input.body : '');
      return node('AddCommentPayload', { comment });
    }
    default:
      throw unknown('Mutation', field);
  }
}

function repoById(forge: Forge, id: string): Repo | null {
  if (!id.startsWith('R_')) return null;
  const repoId = Number(id.slice(2));
  for (const repo of forge.repos.values()) if (repo.id === repoId) return repo;
  return null;
}

function threadById(forge: Forge, id: string): { repo: Repo; thread: Thread } | null {
  const match = /^([IP])_(\d+)_(\d+)$/.exec(id);
  if (match === null) return null;
  const repoId = Number(match[2]);
  const number = Number(match[3]);
  for (const repo of forge.repos.values()) {
    if (repo.id !== repoId) continue;
    const thread = repo.threads.get(number);
    if (thread !== undefined) return { repo, thread };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// introspection

interface TypeDescriptor {
  kind: string;
  name: string;
  fields?: TypeFieldDescriptor[];
  enumValues?: { name: string; description: string }[];
}

interface TypeFieldDescriptor {
  name: string;
  description: string;
  type: string;
  args?: { name: string; type: string }[];
}

const FIELD_TYPES: Readonly<Record<string, [string, string][]>> = {
  Issue: [
    ['id', 'ID!'],
    ['number', 'Int!'],
    ['title', 'String!'],
    ['body', 'String'],
    ['state', 'IssueState!'],
    ['createdAt', 'DateTime!'],
    ['updatedAt', 'DateTime!'],
    ['closed', 'Boolean!'],
    ['closedAt', 'DateTime'],
    ['author', 'User'],
    ['repository', 'Repository!'],
    ['labels', 'LabelConnection'],
    ['comments', 'IssueCommentConnection'],
    ['url', 'URI!'],
  ],
  PullRequest: [
    ['id', 'ID!'],
    ['number', 'Int!'],
    ['title', 'String!'],
    ['body', 'String'],
    ['state', 'PullRequestState!'],
    ['merged', 'Boolean!'],
    ['mergedAt', 'DateTime'],
    ['mergeCommit', 'Commit'],
    ['headRefName', 'String!'],
    ['baseRefName', 'String!'],
    ['headRefOid', 'GitObjectID!'],
    ['baseRefOid', 'GitObjectID!'],
    ['mergeable', 'MergeableState!'],
    ['mergeStateStatus', 'MergeStateStatus!'],
    ['isDraft', 'Boolean!'],
    ['changedFiles', 'Int!'],
    ['additions', 'Int!'],
    ['deletions', 'Int!'],
    ['files', 'PullRequestChangedFileConnection'],
    ['author', 'User'],
    ['repository', 'Repository!'],
    ['headRepository', 'Repository'],
    ['baseRepository', 'Repository'],
    ['comments', 'IssueCommentConnection'],
    ['commits', 'PullRequestCommitConnection'],
    ['url', 'URI!'],
  ],
  Repository: [
    ['id', 'ID!'],
    ['databaseId', 'Int'],
    ['name', 'String!'],
    ['nameWithOwner', 'String!'],
    ['owner', 'RepositoryOwner!'],
    ['description', 'String'],
    ['isPrivate', 'Boolean!'],
    ['visibility', 'RepositoryVisibility!'],
    ['defaultBranchRef', 'Ref'],
    ['viewerPermission', 'RepositoryPermission'],
    ['hasIssuesEnabled', 'Boolean!'],
    ['hasWikiEnabled', 'Boolean!'],
    ['hasProjectsEnabled', 'Boolean!'],
    ['isFork', 'Boolean!'],
    ['isArchived', 'Boolean!'],
    ['isDisabled', 'Boolean!'],
    ['isTemplate', 'Boolean!'],
    ['createdAt', 'DateTime!'],
    ['updatedAt', 'DateTime!'],
    ['pushedAt', 'DateTime'],
    ['url', 'URI!'],
    ['sshUrl', 'GitSSHRemote!'],
    ['stargazerCount', 'Int!'],
    ['forkCount', 'Int!'],
    ['diskUsage', 'Int'],
    ['watchers', 'WatcherConnection'],
    ['primaryLanguage', 'Language'],
    ['licenseInfo', 'License'],
    ['parent', 'Repository'],
    ['object', 'GitObject'],
    ['ref', 'Ref'],
    ['milestone', 'Milestone'],
    ['repositoryTopics', 'RepositoryTopicConnection'],
    ['labels', 'LabelConnection'],
    ['issue', 'Issue'],
    ['issues', 'IssueConnection'],
    ['pullRequests', 'PullRequestConnection'],
    ['pullRequest', 'PullRequest'],
  ],
  User: [
    ['id', 'ID!'],
    ['login', 'String!'],
    ['name', 'String'],
    ['email', 'String!'],
    ['avatarUrl', 'URI!'],
    ['url', 'URI!'],
  ],
  IssueConnection: [
    ['nodes', '[Issue]'],
    ['edges', '[IssueEdge]'],
    ['pageInfo', 'PageInfo!'],
    ['totalCount', 'Int!'],
  ],
  PullRequestConnection: [
    ['nodes', '[PullRequest]'],
    ['edges', '[PullRequestEdge]'],
    ['pageInfo', 'PageInfo!'],
    ['totalCount', 'Int!'],
  ],
  PageInfo: [
    ['hasNextPage', 'Boolean!'],
    ['hasPreviousPage', 'Boolean!'],
    ['startCursor', 'String'],
    ['endCursor', 'String'],
  ],
  PullRequestChangedFile: [
    ['path', 'String!'],
    ['additions', 'Int!'],
    ['deletions', 'Int!'],
    ['changeType', 'PatchStatus!'],
  ],
  IssueComment: [
    ['id', 'ID!'],
    ['body', 'String!'],
    ['author', 'User'],
  ],
  Ref: [
    ['name', 'String!'],
    ['target', 'GitObject'],
  ],
  Label: [
    ['name', 'String!'],
    ['color', 'String!'],
  ],
  LabelConnection: [
    ['nodes', '[Label]'],
    ['pageInfo', 'PageInfo!'],
    ['totalCount', 'Int!'],
  ],
  IssueCommentConnection: [
    ['nodes', '[IssueComment]'],
    ['pageInfo', 'PageInfo!'],
    ['totalCount', 'Int!'],
  ],
};

const ENUM_VALUES: Readonly<Record<string, string[]>> = {
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  RepositoryVisibility: ['PUBLIC', 'PRIVATE', 'INTERNAL'],
  MergeStateStatus: ['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE'],
  PatchStatus: ['ADDED', 'DELETED', 'MODIFIED'],
  IssueStateReason: ['COMPLETED', 'NOT_PLANNED', 'REOPENED'],
};

const PAYLOAD_TYPES: Readonly<Record<string, [string, string][]>> = {
  CreateIssuePayload: [['issue', 'Issue'], ['clientMutationId', 'String']],
  CloseIssuePayload: [['issue', 'Issue'], ['clientMutationId', 'String']],
  CreatePullRequestPayload: [['pullRequest', 'PullRequest'], ['clientMutationId', 'String']],
  MergePullRequestPayload: [['pullRequest', 'PullRequest'], ['clientMutationId', 'String']],
  AddCommentPayload: [['commentEdge', 'IssueCommentEdge'], ['clientMutationId', 'String']],
  IssueCommentEdge: [['node', 'IssueComment'], ['cursor', 'String!']],
};

function typeDescriptor(name: string): TypeDescriptor | null {
  if (name === 'SearchType' || ENUM_VALUES[name] !== undefined) {
    const values = ENUM_VALUES[name];
    if (values === undefined) return null;
    return { kind: 'ENUM', name, enumValues: values.map((value) => ({ name: value, description: `${value} value` })) };
  }
  const fields = FIELD_TYPES[name] ?? PAYLOAD_TYPES[name];
  if (fields === undefined) return null;
  return {
    kind: 'OBJECT',
    name,
    fields: fields.map(([fieldName, type]) => ({ name: fieldName, description: `${fieldName} of ${name}`, type })),
  };
}

function resolveType(descriptor: TypeDescriptor, field: string, args: Record<string, unknown>): Resolved {
  switch (field) {
    case 'kind':
      return scalar(descriptor.kind);
    case 'name':
      return scalar(descriptor.name);
    case 'description':
      return scalar(`${descriptor.name} type`);
    case 'fields':
      return { typename: 'TypeField', value: (descriptor.fields ?? []).map((entry) => ({ ...entry })) };
    case 'enumValues':
      return { typename: 'EnumValue', value: (descriptor.enumValues ?? []).map((entry) => ({ ...entry })) };
    case 'inputFields':
      return scalar([]);
    case 'interfaces':
      return scalar([]);
    case 'possibleTypes':
      return scalar([]);
    default:
      void args;
      throw unknown('__Type', field);
  }
}

function resolveTypeField(field: TypeFieldDescriptor, name: string, args: Record<string, unknown>): Resolved {
  void args;
  switch (name) {
    case 'name':
      return scalar(field.name);
    case 'description':
      return scalar(field.description);
    case 'isDeprecated':
      return scalar(false);
    case 'deprecationReason':
      return scalar(null);
    case 'args':
      return scalar((field.args ?? []).map((arg) => ({ name: arg.name })));
    case 'type': {
      const text = field.type.replace(/[[\]!]/g, '');
      const kind = ENUM_VALUES[text] !== undefined ? 'ENUM' : 'OBJECT';
      return node('Type', { kind, name: text, fields: undefined, enumValues: ENUM_VALUES[text]?.map((value) => ({ name: value, description: value })) });
    }
    default:
      throw unknown('__Field', name);
  }
}

