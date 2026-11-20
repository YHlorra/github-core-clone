// The forge's memory: users, repositories, their git objects and refs, and the issue/pull records built
// on top. Everything is in-process; ids and timestamps are deterministic (a clock derived from the
// trial's start time that advances one second per read) so two identical runs produce identical output.

import { buildCommit, buildTree, hashObject, parseCommit, parseTree, ZERO_OID, isTreeMode, type GitObject, type Identity, type TreeEntry } from './git-objects.ts';
import { flattenTree, isAncestor } from './pack.ts';

export const DEFAULT_BRANCH = 'main';

export interface User extends Identity {
  id: number;
  login: string;
}

/** The one login this process serves: the token names it. */
export const VIEWER: User = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
}

export interface Pull {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
  head: string;
  base: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export type Thread = Issue | Pull;

export function isPull(thread: Thread): thread is Pull {
  return (thread as Pull).kind === 'pull';
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string | null;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  threads: Map<number, Thread>;
  nextNumber: number;
  nextCommentId: number;
}

export interface FileChange {
  path: string;
  /** null removes the path. */
  content: string | null;
  mode?: string;
}

/** Milliseconds of the trial clock: MAKEFUN_TRIAL_NOW when set, else the suite's fixed epoch. */
function clockBaseMs(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 1_735_689_600_000;
}

let clockMs = clockBaseMs();
let clockTick = 0;

/** The next timestamp, one second at a time, as GitHub's `2020-01-01T00:00:00Z`. */
export function nextTimestamp(): string {
  clockTick += 1;
  return new Date(clockMs + clockTick * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The same clock in epoch seconds, for commit headers. */
export function nextEpochSec(): number {
  clockTick += 1;
  return Math.trunc((clockMs + clockTick * 1000) / 1000);
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextThreadId = 100_000;

  key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  find(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  /** The repositories the token's login owns, newest last. */
  ownRepos(): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner.toLowerCase() === VIEWER.login);
  }

  createRepo(options: { name: string; description?: string; private?: boolean; owner?: string }): Repo {
    const owner = (options.owner ?? VIEWER.login).toLowerCase();
    const key = this.key(owner, options.name);
    if (this.repos.has(key)) throw new Conflict(`a repository named ${options.name} already exists on this account`);
    const now = nextTimestamp();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name: options.name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: now,
      updatedAt: now,
      pushedAt: null,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      threads: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.key(repo.owner, repo.name));
  }

  nextThreadNumber(repo: Repo): number {
    return repo.nextNumber++;
  }

  nextId(): number {
    this.nextThreadId += 1;
    return this.nextThreadId;
  }
}

/** A request the API must answer with 409. */
export class Conflict extends Error {}

// ---------------------------------------------------------------------------------------------
// git storage

export function storeObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function lookup(repo: Repo) {
  return (oid: string): GitObject | undefined => repo.objects.get(oid);
}

/** `refs/heads/<branch>`'s tip, or undefined for an unborn branch. */
export function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** Resolve a ref name (branch, tag, or `HEAD`) or a raw object id to a commit id. */
export function resolveCommitish(repo: Repo, name: string): string | undefined {
  if (name === '' || name === 'HEAD') return branchTip(repo, repo.defaultBranch);
  const direct = repo.refs.get(name) ?? repo.refs.get(`refs/heads/${name}`) ?? repo.refs.get(`refs/tags/${name}`);
  if (direct !== undefined) return direct;
  if (/^[0-9a-f]{40}$/.test(name) && repo.objects.has(name)) return name;
  return undefined;
}

/** A commit's tree as `path → { mode, oid }`, for the whole tree. */
export function commitFiles(repo: Repo, commitOid: string): Map<string, { mode: string; oid: string }> {
  const commit = parseCommit(repo.objects.get(commitOid)?.data ?? Buffer.alloc(0));
  return flattenTree(commit.tree, lookup(repo));
}

/** Build nested trees from a flat path map and return the root tree's id. */
export function writeTreeFromFiles(repo: Repo, files: Map<string, { mode: string; oid: string }>): string {
  interface Node {
    files: TreeEntry[];
    dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]!;
      let child = node.dirs.get(segment);
      if (child === undefined) {
        child = { files: [], dirs: new Map() };
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.push({ mode: entry.mode, name: segments[segments.length - 1]!, oid: entry.oid });
  }
  const write = (node: Node): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: write(child) });
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return write(root);
}

export interface CommitOptions {
  branch: string;
  message: string;
  changes: readonly FileChange[];
  /** Commit to build on; defaults to the branch tip (or a root commit when the branch is unborn). */
  parent?: string;
  /** Replace the whole tree instead of applying `changes` to the parent's tree. */
  baseFiles?: Map<string, { mode: string; oid: string }>;
}

/** Apply file changes on top of a commit and store the resulting commit, returning its id. */
export function commitChanges(repo: Repo, options: CommitOptions): { commit: string; files: Map<string, { mode: string; oid: string }> } {
  const parent = options.parent ?? branchTip(repo, options.branch);
  const files = options.baseFiles !== undefined
    ? new Map(options.baseFiles)
    : parent !== undefined && repo.objects.has(parent)
      ? commitFiles(repo, parent)
      : new Map<string, { mode: string; oid: string }>();
  for (const change of options.changes) {
    if (change.content === null) {
      files.delete(change.path);
    } else {
      const oid = storeObject(repo, 'blob', Buffer.from(change.content, 'utf8'));
      files.set(change.path, { mode: change.mode ?? '100644', oid });
    }
  }
  const tree = writeTreeFromFiles(repo, files);
  const epochSec = nextEpochSec();
  const data = buildCommit({
    tree,
    parents: parent === undefined ? [] : [parent],
    message: options.message,
    identity: { name: VIEWER.name, email: VIEWER.email },
    epochSec,
  });
  const commit = storeObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${options.branch}`, commit);
  repo.pushedAt = nextTimestamp();
  repo.updatedAt = repo.pushedAt;
  return { commit, files };
}

/** Create a branch at `sha`; false when the object is not a commit. */
export function createBranch(repo: Repo, branch: string, sha: string): boolean {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return false;
  repo.refs.set(`refs/heads/${branch}`, sha);
  return true;
}

/** Walk a commit's history newest first, at most `limit` entries. */
export function commitHistory(repo: Repo, tip: string, limit = 100): { sha: string; commit: ReturnType<typeof parseCommit> }[] {
  const out: { sha: string; commit: ReturnType<typeof parseCommit> }[] = [];
  const seen = new Set<string>();
  let frontier = [tip];
  while (frontier.length > 0 && out.length < limit) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      out.push({ sha: oid, commit });
      for (const parent of commit.parents) next.push(parent);
      if (out.length >= limit) break;
    }
    frontier = next;
  }
  return out;
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function lineCount(data: Buffer | undefined): number {
  if (data === undefined || data.length === 0) return 0;
  let count = data.toString('utf8').split('\n').length;
  if (data[data.length - 1] === 0x0a) count -= 1;
  return count;
}

/** Compare two flat trees into a GitHub-style file diff. */
export function diffTrees(
  repo: Repo,
  before: Map<string, { mode: string; oid: string }>,
  after: Map<string, { mode: string; oid: string }>,
): FileDiff[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  const out: FileDiff[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry?.oid === newEntry?.oid) continue;
    let status: FileDiff['status'];
    let additions = 0;
    let deletions = 0;
    if (oldEntry === undefined) {
      status = 'added';
      additions = lineCount(repo.objects.get(newEntry!.oid)?.data);
    } else if (newEntry === undefined) {
      status = 'removed';
      deletions = lineCount(repo.objects.get(oldEntry.oid)?.data);
    } else {
      status = 'modified';
      const oldLines = new Set(repo.objects.get(oldEntry.oid)?.data.toString('utf8').split('\n') ?? []);
      const newLines = repo.objects.get(newEntry.oid)?.data.toString('utf8').split('\n') ?? [];
      additions = newLines.filter((line) => !oldLines.has(line)).length;
      deletions = [...oldLines].filter((line) => !newLines.includes(line)).length;
      if (additions === 0 && deletions === 0) additions = 1;
    }
    out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return out;
}

/** The best common ancestor of two commits, or undefined when they are unrelated. */export function mergeBase(repo: Repo, a: string, b: string): string | undefined {
  const ancestors = new Set<string>();
  const walk = (start: string, seen: Set<string> | null): void => {
    const queue = [start];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (oid === ZERO_OID) continue;
      if (seen !== null) {
        if (seen.has(oid)) continue;
        seen.add(oid);
      }
      ancestors.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
  };
  walk(a, null);
  const fromB = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (fromB.has(oid)) continue;
    fromB.add(oid);
    if (ancestors.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return undefined;
}

export { isAncestor, flattenTree, isTreeMode };

// ---------------------------------------------------------------------------------------------
// record creation, shared by REST, GraphQL and MCP so every surface sees the same objects

export interface ThreadInput {
  title: string;
  body: string;
  labels?: readonly Label[];
  state?: 'open' | 'closed';
  user?: string;
}

export function addIssue(forge: Forge, repo: Repo, input: ThreadInput): Issue {
  const now = nextTimestamp();
  const issue: Issue = {
    id: forge.nextId(),
    number: forge.nextThreadNumber(repo),
    title: input.title,
    body: input.body,
    state: input.state ?? 'open',
    labels: [...(input.labels ?? [])],
    user: input.user ?? VIEWER.login,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: [],
  };
  repo.threads.set(issue.number, issue);
  return issue;
}

export interface PullInput extends ThreadInput {
  head: string;
  base: string;
}

export function addPull(forge: Forge, repo: Repo, input: PullInput): Pull {
  const now = nextTimestamp();
  const pull: Pull = {
    kind: 'pull',
    id: forge.nextId(),
    number: forge.nextThreadNumber(repo),
    title: input.title,
    body: input.body,
    state: input.state ?? 'open',
    labels: [...(input.labels ?? [])],
    user: input.user ?? VIEWER.login,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: [],
    head: input.head,
    base: input.base,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
  };
  repo.threads.set(pull.number, pull);
  return pull;
}

export function addComment(forge: Forge, repo: Repo, thread: Thread, body: string): Comment {
  const comment: Comment = { id: repo.nextCommentId++, body, user: VIEWER.login, createdAt: nextTimestamp() };
  thread.comments.push(comment);
  thread.updatedAt = comment.createdAt;
  void forge;
  return comment;
}

export interface MergeOutcome {
  ok: boolean;
  sha?: string;
  reason?: string;
}

/** Merge a pull request into its base branch, refusing with `reason` when the branches conflict. */
export function mergePullRecord(repo: Repo, pull: Pull): MergeOutcome {
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (headTip === undefined || baseTip === undefined) return { ok: false, reason: 'Pull Request is not mergeable' };
  if (pull.merged) return { ok: false, reason: 'Pull Request is not mergeable' };
  const base = mergeBase(repo, baseTip, headTip);
  const headFiles = commitFiles(repo, headTip);
  const ancestorFiles = base === undefined ? new Map<string, { mode: string; oid: string }>() : commitFiles(repo, base);
  const currentFiles = commitFiles(repo, baseTip);
  const changed = diffTrees(repo, ancestorFiles, headFiles);
  for (const change of changed) {
    const current = currentFiles.get(change.filename);
    const ancestor = ancestorFiles.get(change.filename);
    const head = headFiles.get(change.filename);
    if (current?.oid !== ancestor?.oid && current?.oid !== head?.oid) {
      return { ok: false, reason: 'Pull Request is not mergeable' };
    }
  }
  let mergedSha = baseTip;
  if (changed.length > 0) {
    const nextFiles = new Map(currentFiles);
    for (const change of changed) {
      const head = headFiles.get(change.filename);
      if (head === undefined) nextFiles.delete(change.filename);
      else nextFiles.set(change.filename, head);
    }
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}\n\n${pull.title}`;
    mergedSha = commitChanges(repo, { branch: pull.base, message, changes: [], baseFiles: nextFiles, parent: baseTip }).commit;
  }
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = nextTimestamp();
  pull.mergeCommitSha = mergedSha;
  pull.closedAt = pull.mergedAt;
  pull.updatedAt = pull.mergedAt;
  return { ok: true, sha: mergedSha };
}
