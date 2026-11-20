// The REST v3 surface: repositories, contents, refs, branches, commits, labels, issues, comments and
// pull requests. Handlers return `{status, body, headers}`; failures are `ApiError`s the router turns
// into GitHub's `{"message": ...}` reply.

import { ApiError, objectBody, parseJsonBody } from './http.ts';
import {
  VIEWER,
  addComment,
  addIssue,
  addPull,
  branchTip,
  commitChanges,
  commitFiles,
  commitHistory,
  createBranch,
  diffTrees,
  isPull,
  mergeBase,
  mergePullRecord,
  nextEpochSec,
  nextTimestamp,
  resolveCommitish,
  writeTreeFromFiles,
  type Comment,
  type FileChange,
  type Label,
  type Pull,
  type Repo,
  type Thread,
} from './model.ts';
import { flattenTree, isAncestor } from './pack.ts';

export interface RestRequest {
  forge: import('./model.ts').Forge;
  method: string;
  /** Path segments after `/api/v3`, already percent-decoded. */
  segments: string[];
  query: URLSearchParams;
  body: Buffer;
  baseUrl: string;
}

export interface RestResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** The request's JSON body, parsed on each call (handlers parse at most once). */
function bodyJson(req: RestRequest): unknown {
  return parseJsonBody(req.body);
}

export function handleRest(req: RestRequest): RestResult {
  const { segments, method } = req;
  if (segments.length === 0) {
    return {
      status: 200,
      headers: { 'x-oauth-scopes': 'repo, read:org' },
      body: {
        current_user_url: `${req.baseUrl}/api/v3/user`,
        current_user_authorizations_html_url: 'https://github.com/settings/connections/applications{/client_id}',
        authorizations_url: `${req.baseUrl}/api/v3/authorizations`,
        code_search_url: `${req.baseUrl}/api/v3/search/code?q={query}{&page,per_page,sort,order}`,
        commit_search_url: `${req.baseUrl}/api/v3/search/commits?q={query}{&page,per_page,sort,order}`,
        emails_url: `${req.baseUrl}/api/v3/user/emails`,
        emojis_url: `${req.baseUrl}/api/v3/emojis`,
        events_url: `${req.baseUrl}/api/v3/events`,
        feeds_url: `${req.baseUrl}/api/v3/feeds`,
        followers_url: `${req.baseUrl}/api/v3/user/followers`,
        following_url: `${req.baseUrl}/api/v3/user/following{/target}`,
        gists_url: `${req.baseUrl}/api/v3/gists{/gist_id}`,
        hub_url: `${req.baseUrl}/api/v3/hub`,
        issue_search_url: `${req.baseUrl}/api/v3/search/issues?q={query}{&page,per_page,sort,order}`,
        issues_url: `${req.baseUrl}/api/v3/issues`,
        keys_url: `${req.baseUrl}/api/v3/user/keys`,
        label_search_url: `${req.baseUrl}/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}`,
        notifications_url: `${req.baseUrl}/api/v3/notifications`,
        organization_url: `${req.baseUrl}/api/v3/orgs/{org}`,
        organization_repositories_url: `${req.baseUrl}/api/v3/orgs/{org}/repos{?type,page,per_page,sort}`,
        organization_teams_url: `${req.baseUrl}/api/v3/orgs/{org}/teams`,
        public_gists_url: `${req.baseUrl}/api/v3/gists/public`,
        rate_limit_url: `${req.baseUrl}/api/v3/rate_limit`,
        repository_url: `${req.baseUrl}/api/v3/repos/{owner}/{repo}`,
        repository_search_url: `${req.baseUrl}/api/v3/search/repositories?q={query}{&page,per_page,sort,order}`,
        current_user_repositories_url: `${req.baseUrl}/api/v3/user/repos{?type,page,per_page,sort}`,
        starred_url: `${req.baseUrl}/api/v3/user/starred{/owner}{/repo}`,
        starred_gists_url: `${req.baseUrl}/api/v3/gists/starred`,
        topic_search_url: `${req.baseUrl}/api/v3/search/topics?q={query}{&page,per_page}`,
        user_url: `${req.baseUrl}/api/v3/users/{user}`,
        user_organizations_url: `${req.baseUrl}/api/v3/user/orgs`,
        user_repositories_url: `${req.baseUrl}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
        user_search_url: `${req.baseUrl}/api/v3/search/users?q={query}{&page,per_page,sort,order}`,
      },
    };
  }

  const head = segments[0];
  if (head === 'meta' && segments.length === 1) {
    return { status: 200, body: { verifiable_password_authentication: true, installed_version: '3.0.0-ghclone' } };
  }
  if (head === 'rate_limit' && segments.length === 1) {
    const reset = nextEpochSec() + 3600;
    return {
      status: 200,
      body: {
        resources: {
          core: { limit: 5000, used: 0, remaining: 5000, reset },
          search: { limit: 30, used: 0, remaining: 30, reset },
        },
        rate: { limit: 5000, used: 0, remaining: 5000, reset },
      },
    };
  }
  if (head === 'user' && segments.length === 1) {
    return method === 'GET' ? { status: 200, body: userJson(VIEWER.login) } : notFound();
  }
  if (head === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') return listOwnRepos(req);
    if (method === 'POST') return createRepo(req);
    return notFound();
  }
  if (head === 'repos' && segments.length >= 3) {
    const owner = segments[1]!;
    const name = segments[2]!;
    return routeRepo(req, owner, name, segments.slice(3));
  }
  return notFound();
}

// ---------------------------------------------------------------------------------------------
// repositories

function listOwnRepos(req: RestRequest): RestResult {
  const perPage = clampPerPage(req.query.get('per_page'));
  const page = Math.max(1, Number(req.query.get('page') ?? '1') || 1);
  const all = req.forge.ownRepos();
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage).map((repo) => repoJson(repo, req.baseUrl));
  const headers: Record<string, string> = {};
  const links: string[] = [];
  const makeUrl = (target: number): string => `${req.baseUrl}/api/v3/user/repos?per_page=${perPage}&page=${target}`;
  if (start + perPage < all.length) links.push(`<${makeUrl(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${makeUrl(page - 1)}>; rel="prev"`);
  links.push(`<${makeUrl(1)}>; rel="first"`);
  const lastPage = Math.max(1, Math.ceil(all.length / perPage));
  links.push(`<${makeUrl(lastPage)}>; rel="last"`);
  headers.link = links.join(', ');
  return { status: 200, body: items, headers };
}

function createRepo(req: RestRequest): RestResult {
  const body = objectBody(bodyJson(req));
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') throw new ApiError(422, 'Repository creation failed', { errors: [{ resource: 'Repository', field: 'name', message: 'name is required' }] });
  if (req.forge.find(VIEWER.login, name) !== undefined) {
    throw new ApiError(422, `Repository creation failed.`, {
      errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: `name already exists on this account` }],
    });
  }
  const repo = req.forge.createRepo({
    name,
    description: typeof body.description === 'string' ? body.description : '',
    private: body.private === true,
  });
  return { status: 201, body: repoJson(repo, req.baseUrl), headers: { location: `${req.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}` } };
}

function routeRepo(req: RestRequest, owner: string, name: string, rest: string[]): RestResult {
  const repo = req.forge.find(owner, name);
  if (repo === undefined) return notFound();
  const { method } = req;
  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo, req.baseUrl) };
    if (method === 'PATCH') return patchRepo(req, repo);
    if (method === 'DELETE') {
      req.forge.deleteRepo(repo);
      return { status: 204 };
    }
    return notFound();
  }

  const section = rest[0];
  const tail = rest.slice(1);

  if (section === 'branches') {
    if (method !== 'GET') return notFound();
    if (tail.length === 0) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return { status: 200, body: branches };
    }
    const branch = tail.join('/');
    const sha = branchTip(repo, branch);
    if (sha === undefined) return notFound();
    return { status: 200, body: { name: branch, commit: { sha }, protected: false } };
  }

  if (section === 'commits' && tail.length === 0) {
    if (method !== 'GET') return notFound();
    const ref = req.query.get('sha') ?? repo.defaultBranch;
    const tip = resolveCommitish(repo, ref);
    if (tip === undefined) throw new ApiError(404, 'No commit found for SHA');
    const limit = clampPerPage(req.query.get('per_page'));
    const history = commitHistory(repo, tip, limit);
    return {
      status: 200,
      body: history.map(({ sha, commit }) => ({
        sha,
        node_id: `C_${sha}`,
        commit: {
          author: { name: authorName(commit.author), email: authorEmail(commit.author), date: timestampOf(commit.author) },
          committer: { name: authorName(commit.committer), email: authorEmail(commit.committer), date: timestampOf(commit.committer) },
          message: trimMessage(commit.message),
          tree: { sha: commit.tree },
          url: `${req.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${commit.tree}`,
          comment_count: 0,
          verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
        },
        url: `${req.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
        html_url: `${req.baseUrl}/${repo.owner}/${repo.name}/commit/${sha}`,
        parents: commit.parents.map((parent) => ({ sha: parent, url: `${req.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/commits/${parent}` })),
      })),
    };
  }

  if (section === 'git' && tail[0] === 'refs') {
    return routeRefs(req, repo, tail.slice(1));
  }

  if (section === 'contents') {
    const path = tail.join('/');
    if (method === 'GET') return getContents(req, repo, path);
    if (method === 'PUT') return putContents(req, repo, path);
    if (method === 'DELETE') return deleteContents(req, repo, path);
    return notFound();
  }

  if (section === 'labels') {
    if (tail.length === 0) {
      if (method === 'GET') return { status: 200, body: [...repo.labels.values()].map((label) => labelJson(label)) };
      if (method === 'POST') return createLabel(req, repo);
      return notFound();
    }
    const label = repo.labels.get(tail.join('/'));
    if (label === undefined) return notFound();
    return { status: 200, body: labelJson(label) };
  }

  if (section === 'issues') return routeIssues(req, repo, tail);
  if (section === 'pulls') return routePulls(req, repo, tail);
  return notFound();
}

function patchRepo(req: RestRequest, repo: Repo): RestResult {
  const body = objectBody(bodyJson(req));
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.name === 'string' && body.name !== repo.name) repo.name = body.name;
  if (body.private !== undefined) repo.private = body.private === true;
  if (body.default_branch !== undefined && typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch;
  repo.updatedAt = nextTimestamp();
  return { status: 200, body: repoJson(repo, req.baseUrl) };
}

function routeRefs(req: RestRequest, repo: Repo, tail: string[]): RestResult {
  const { method } = req;
  if (method === 'POST' && tail.length === 0) {
    const body = objectBody(bodyJson(req));
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/heads/')) throw new ApiError(422, 'Reference must start with refs/heads/');
    if (repo.refs.has(ref)) throw new ApiError(422, 'Reference already exists');
    if (!createBranch(repo, ref.slice('refs/heads/'.length), sha)) {
      throw new ApiError(422, `Object ${sha} does not exist`);
    }
    return { status: 201, body: { ref, node_id: `R_${sha}`, url: `${req.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/git/${ref}`, object: { sha, type: 'commit', url: `${req.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` } } };
  }
  if (method === 'GET' && tail.length > 0) {
    const ref = tail.join('/');
    const sha = repo.refs.get(ref) ?? repo.refs.get(`refs/${ref}`) ?? repo.refs.get(`refs/heads/${ref}`);
    if (sha === undefined) return notFound();
    return { status: 200, body: { ref: ref.startsWith('refs/') ? ref : `refs/${ref}`, object: { sha, type: 'commit' } } };
  }
  return notFound();
}

// ---------------------------------------------------------------------------------------------
// contents

function resolveTree(req: RestRequest, repo: Repo, ref: string | null): Map<string, { mode: string; oid: string }> | null {
  const target = ref === null || ref === '' ? repo.defaultBranch : ref;
  const tip = resolveCommitish(repo, target);
  if (tip === undefined) return null;
  return commitFiles(repo, tip);
}

function getContents(req: RestRequest, repo: Repo, path: string): RestResult {
  const files = resolveTree(req, repo, req.query.get('ref'));
  if (files === null) return notFound();
  const key = normalisePath(path);
  if (key !== '' && files.has(key)) {
    const entry = files.get(key)!;
    const blob = repo.objects.get(entry.oid);
    const data = blob?.data ?? Buffer.alloc(0);
    return {
      status: 200,
      body: {
        name: key.split('/').pop(),
        path: key,
        sha: entry.oid,
        size: data.length,
        type: 'file',
        encoding: 'base64',
        content: data.toString('base64'),
        url: `${req.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/contents/${key}`,
        git_url: `${req.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${entry.oid}`,
        html_url: `${req.baseUrl}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${key}`,
        download_url: `${req.baseUrl}/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${key}`,
      },
    };
  }
  const prefix = key === '' ? '' : `${key}/`;
  const names = new Map<string, { mode: string; oid: string }>();
  for (const [filePath, entry] of files) {
    if (!filePath.startsWith(prefix)) continue;
    const remainder = filePath.slice(prefix.length);
    const slash = remainder.indexOf('/');
    const name = slash === -1 ? remainder : remainder.slice(0, slash);
    const childPath = `${prefix}${name}`;
    if (slash === -1) names.set(name, entry);
    else if (!names.has(name)) {
      const childFiles = new Map<string, { mode: string; oid: string }>();
      for (const [inner, innerEntry] of files) {
        if (inner.startsWith(`${childPath}/`)) childFiles.set(inner.slice(childPath.length + 1), innerEntry);
      }
      names.set(name, { mode: '40000', oid: writeTreeFromFiles(repo, childFiles) });
    }
  }
  if (key !== '' && names.size === 0) return notFound();
  const body = [...names.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, entry]) => {
      const isDir = entry.mode === '40000' || entry.mode === '040000';
      const entryPath = `${key === '' ? '' : `${key}/`}${name}`;
      return {
        name,
        path: entryPath,
        sha: entry.oid,
        size: isDir ? 0 : repo.objects.get(entry.oid)?.data.length ?? 0,
        type: isDir ? 'dir' : 'file',
        url: `${req.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/contents/${entryPath}`,
        html_url: `${req.baseUrl}/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${entryPath}`,
        git_url: null,
        download_url: null,
      };
    });
  return { status: 200, body };
}

function putContents(req: RestRequest, repo: Repo, path: string): RestResult {
  const body = objectBody(bodyJson(req));
  const key = normalisePath(path);
  if (key === '') throw new ApiError(422, 'Invalid path');
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Update ${key}`;
  const content = typeof body.content === 'string' ? Buffer.from(body.content.replace(/\n/g, ''), 'base64') : Buffer.alloc(0);
  const tip = branchTip(repo, branch);
  if (tip === undefined && repo.refs.size > 0 && typeof body.branch === 'string') {
    return notFound();
  }
  const current = tip === undefined ? new Map<string, { mode: string; oid: string }>() : commitFiles(repo, tip);
  const existing = current.get(key);
  if (typeof body.sha === 'string' && body.sha !== '' && existing !== undefined && body.sha.toLowerCase() !== existing.oid) {
    throw new ApiError(409, `${key} does not match ${body.sha}`);
  }
  const existed = existing !== undefined;
  const changes: FileChange[] = [{ path: key, content }];
  const { commit } = commitChanges(repo, { branch, message, changes, parent: tip });
  const blobOid = commitFiles(repo, commit).get(key)?.oid ?? '';
  return {
    status: existed ? 200 : 201,
    body: {
      content: {
        name: key.split('/').pop(),
        path: key,
        sha: blobOid,
        size: content.length,
        type: 'file',
        encoding: 'base64',
        content: content.toString('base64'),
        url: `${req.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/contents/${key}`,
        git_url: `${req.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
        html_url: `${req.baseUrl}/${repo.owner}/${repo.name}/blob/${branch}/${key}`,
        download_url: `${req.baseUrl}/${repo.owner}/${repo.name}/raw/${branch}/${key}`,
      },
      commit: commitJson(repo, commit, req.baseUrl),
    },
  };
}

function deleteContents(req: RestRequest, repo: Repo, path: string): RestResult {
  const body = objectBody(bodyJson(req));
  const key = normalisePath(path);
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const tip = branchTip(repo, branch);
  if (tip === undefined) return notFound();
  const current = commitFiles(repo, tip);
  if (!current.has(key)) return notFound();
  const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Delete ${key}`;
  const { commit } = commitChanges(repo, { branch, message, changes: [{ path: key, content: null }], parent: tip });
  return { status: 200, body: { content: null, commit: commitJson(repo, commit, req.baseUrl) } };
}

function commitJson(repo: Repo, sha: string, baseUrl: string) {
  const commit = commitHistory(repo, sha, 1)[0]?.commit;
  return {
    sha,
    node_id: `C_${sha}`,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/commit/${sha}`,
    message: trimMessage(commit?.message ?? ''),
    tree: { sha: commit?.tree ?? '' },
    parents: (commit?.parents ?? []).map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------------------------------------
// labels and issues

function createLabel(req: RestRequest, repo: Repo): RestResult {
  const body = objectBody(bodyJson(req));
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') throw new ApiError(422, 'name is required');
  const label: Label = {
    name,
    color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed',
    description: typeof body.description === 'string' ? body.description : '',
  };
  repo.labels.set(name, label);
  return { status: 201, body: labelJson(label) };
}

function routeIssues(req: RestRequest, repo: Repo, tail: string[]): RestResult {
  const { method } = req;
  if (tail.length === 0) {
    if (method === 'GET') return { status: 200, body: listThreads(req, repo, false) };
    if (method === 'POST') return createIssue(req, repo);
    return notFound();
  }
  const number = Number(tail[0]);
  if (!Number.isInteger(number)) return notFound();
  const thread = repo.threads.get(number);
  if (tail.length === 1) {
    if (thread === undefined) return notFound();
    if (method === 'GET') return { status: 200, body: threadJson(thread, repo, req.baseUrl) };
    if (method === 'PATCH') return patchThread(req, repo, thread);
    return notFound();
  }
  if (tail[1] === 'comments' && tail.length === 2) {
    if (thread === undefined) return notFound();
    if (method === 'GET') return { status: 200, body: thread.comments.map((comment) => commentJson(comment, req.baseUrl)) };
    if (method === 'POST') {
      const body = objectBody(bodyJson(req));
      const comment = addComment(req.forge, repo, thread, typeof body.body === 'string' ? body.body : '');
      return { status: 201, body: commentJson(comment, req.baseUrl) };
    }
  }
  return notFound();
}

function listThreads(req: RestRequest, repo: Repo, pullsOnly: boolean): unknown[] {
  const state = req.query.get('state') ?? 'open';
  const sort = req.query.get('sort') ?? 'created';
  const direction = (req.query.get('direction') ?? 'desc').toLowerCase();
  const perPage = clampPerPage(req.query.get('per_page'));
  const page = Math.max(1, Number(req.query.get('page') ?? '1') || 1);
  let threads = [...repo.threads.values()].filter((thread) => (pullsOnly ? isPull(thread) : !isPull(thread)));
  if (state !== 'all') threads = threads.filter((thread) => thread.state === state);
  threads.sort((a, b) => {
    let delta = 0;
    if (sort === 'updated') delta = Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
    else if (sort === 'comments') delta = a.comments.length - b.comments.length;
    else delta = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (delta === 0) delta = a.number - b.number;
    return direction === 'asc' ? delta : -delta;
  });
  const slice = threads.slice((page - 1) * perPage, (page - 1) * perPage + perPage);
  return slice.map((thread) => threadJson(thread, repo, req.baseUrl));
}

function createIssue(req: RestRequest, repo: Repo): RestResult {
  const body = objectBody(bodyJson(req));
  const labels = resolveLabels(repo, body.labels);
  const thread = addIssue(req.forge, repo, {
    title: typeof body.title === 'string' ? body.title : '',
    body: typeof body.body === 'string' ? body.body : '',
    labels,
    state: body.state === 'closed' ? 'closed' : 'open',
  });
  return { status: 201, body: threadJson(thread, repo, req.baseUrl) };
}

function patchThread(req: RestRequest, repo: Repo, thread: Thread): RestResult {
  const body = objectBody(bodyJson(req));
  if (typeof body.title === 'string') thread.title = body.title;
  if (typeof body.body === 'string') thread.body = body.body;
  if (body.state === 'open' || body.state === 'closed') {
    if (thread.state !== body.state) {
      thread.state = body.state;
      thread.closedAt = body.state === 'closed' ? nextTimestamp() : null;
    }
  }
  if (body.labels !== undefined) thread.labels = resolveLabels(repo, body.labels);
  thread.updatedAt = nextTimestamp();
  return { status: 200, body: threadJson(thread, repo, req.baseUrl) };
}

function resolveLabels(repo: Repo, raw: unknown): Label[] {
  if (!Array.isArray(raw)) return [];
  const out: Label[] = [];
  for (const item of raw) {
    const name = typeof item === 'string' ? item : typeof (item as { name?: unknown })?.name === 'string' ? String((item as { name: string }).name) : '';
    const label = repo.labels.get(name);
    if (label === undefined) throw new ApiError(422, `Label does not exist: ${name}`);
    out.push(label);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// pulls

function routePulls(req: RestRequest, repo: Repo, tail: string[]): RestResult {
  const { method } = req;
  if (tail.length === 0) {
    if (method === 'GET') return { status: 200, body: listThreads(req, repo, true) };
    if (method === 'POST') return createPull(req, repo);
    return notFound();
  }
  const number = Number(tail[0]);
  if (!Number.isInteger(number)) return notFound();
  const thread = repo.threads.get(number);
  if (thread === undefined || !isPull(thread)) return notFound();
  if (tail.length === 1) {
    if (method === 'GET') return { status: 200, body: pullJson(thread, repo, req.baseUrl) };
    if (method === 'PATCH') return patchThread(req, repo, thread);
    return notFound();
  }
  if (tail[1] === 'files' && tail.length === 2 && method === 'GET') {
    return { status: 200, body: pullFiles(repo, thread) };
  }
  if (tail[1] === 'merge' && tail.length === 2) {
    if (method === 'PUT' || method === 'POST') return mergePull(req, repo, thread);
    if (method === 'GET') {
      if (!thread.merged) return notFound();
      return { status: 204 };
    }
  }
  if (tail[1] === 'comments' && tail.length === 2) {
    if (method === 'GET') return { status: 200, body: thread.comments.map((comment) => commentJson(comment, req.baseUrl)) };
    if (method === 'POST') {
      const body = objectBody(bodyJson(req));
      const comment = addComment(req.forge, repo, thread, typeof body.body === 'string' ? body.body : '');
      return { status: 201, body: commentJson(comment, req.baseUrl) };
    }
  }
  return notFound();
}

function createPull(req: RestRequest, repo: Repo): RestResult {
  const body = objectBody(bodyJson(req));
  const headRef = branchName(typeof body.head === 'string' ? body.head : '');
  const baseRef = branchName(typeof body.base === 'string' ? body.base : repo.defaultBranch);
  const headTip = branchTip(repo, headRef);
  const baseTip = branchTip(repo, baseRef);
  if (headTip === undefined) throw new ApiError(422, `No commits between ${baseRef} and ${headRef}`);
  if (baseTip === undefined) throw new ApiError(422, `Base branch ${baseRef} does not exist`);
  const pull = addPull(req.forge, repo, {
    title: typeof body.title === 'string' ? body.title : '',
    body: typeof body.body === 'string' ? body.body : '',
    labels: resolveLabels(repo, body.labels),
    head: headRef,
    base: baseRef,
  });
  return { status: 201, body: pullJson(pull, repo, req.baseUrl) };
}

function pullFiles(repo: Repo, pull: Pull): unknown[] {
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (headTip === undefined) return [];
  const headFiles = commitFiles(repo, headTip);
  const base = baseTip === undefined ? undefined : mergeBase(repo, baseTip, headTip);
  const ancestorFiles = base === undefined ? new Map<string, { mode: string; oid: string }>() : commitFiles(repo, base);
  return diffTrees(repo, ancestorFiles, headFiles).map((change) => {
    const entry = headFiles.get(change.filename);
    return {
      sha: entry?.oid ?? ancestorFiles.get(change.filename)?.oid ?? '',
      filename: change.filename,
      status: change.status === 'removed' ? 'removed' : ancestorFiles.has(change.filename) ? 'modified' : 'added',
      additions: change.additions,
      deletions: change.deletions,
      changes: change.changes,
      blob_url: '',
      raw_url: '',
      contents_url: '',
      patch: '',
    };
  });
}

function mergePull(req: RestRequest, repo: Repo, pull: Pull): RestResult {
  const body = objectBody(bodyJson(req));
  const outcome = mergePullRecord(repo, pull);
  if (!outcome.ok) throw new ApiError(405, outcome.reason ?? 'Pull Request is not mergeable');
  return {
    status: 200,
    body: {
      sha: outcome.sha ?? '',
      merged: true,
      message: 'Pull Request successfully merged',
      merge_method: typeof body.merge_method === 'string' ? body.merge_method : 'merge',
    },
  };
}

// ---------------------------------------------------------------------------------------------
// JSON shapes

export function userJson(login: string) {
  return {
    login,
    id: VIEWER.id,
    node_id: `U_${VIEWER.id}`,
    avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
    gravatar_id: '',
    url: `/api/v3/users/${login}`,
    html_url: `https://github.com/${login}`,
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

export function labelJson(label: Label) {
  return { id: hash(label.name), node_id: `L_${hash(label.name)}`, name: label.name, color: label.color, description: label.description, default: false };
}

export function repoJson(repo: Repo, baseUrl: string) {
  const full = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: full,
    private: repo.private,
    owner: userJson(repo.owner),
    html_url: `${baseUrl}/${full}`,
    description: repo.description,
    fork: false,
    url: `${baseUrl}/api/v3/repos/${full}`,
    archive_url: `${baseUrl}/api/v3/repos/${full}/{archive_format}{/ref}`,
    assignees_url: `${baseUrl}/api/v3/repos/${full}/assignees{/user}`,
    branches_url: `${baseUrl}/api/v3/repos/${full}/branches{/branch}`,
    collaborators_url: `${baseUrl}/api/v3/repos/${full}/collaborators{/collaborator}`,
    comments_url: `${baseUrl}/api/v3/repos/${full}/comments{/number}`,
    commits_url: `${baseUrl}/api/v3/repos/${full}/commits{/sha}`,
    contents_url: `${baseUrl}/api/v3/repos/${full}/contents/{+path}`,
    contributors_url: `${baseUrl}/api/v3/repos/${full}/contributors`,
    deployments_url: `${baseUrl}/api/v3/repos/${full}/deployments`,
    downloads_url: `${baseUrl}/api/v3/repos/${full}/downloads`,
    events_url: `${baseUrl}/api/v3/repos/${full}/events`,
    forks_url: `${baseUrl}/api/v3/repos/${full}/forks`,
    git_commits_url: `${baseUrl}/api/v3/repos/${full}/git/commits{/sha}`,
    git_refs_url: `${baseUrl}/api/v3/repos/${full}/git/refs{/sha}`,
    git_tags_url: `${baseUrl}/api/v3/repos/${full}/git/tags{/sha}`,
    git_url: `git://localhost/${full}.git`,
    issue_comment_url: `${baseUrl}/api/v3/repos/${full}/issues/comments{/number}`,
    issue_events_url: `${baseUrl}/api/v3/repos/${full}/issues/events{/number}`,
    issues_url: `${baseUrl}/api/v3/repos/${full}/issues{/number}`,
    keys_url: `${baseUrl}/api/v3/repos/${full}/keys{/key_id}`,
    labels_url: `${baseUrl}/api/v3/repos/${full}/labels{/name}`,
    languages_url: `${baseUrl}/api/v3/repos/${full}/languages`,
    merges_url: `${baseUrl}/api/v3/repos/${full}/merges`,
    milestones_url: `${baseUrl}/api/v3/repos/${full}/milestones{/number}`,
    notifications_url: `${baseUrl}/api/v3/repos/${full}/notifications{?since,all,participating}`,
    pulls_url: `${baseUrl}/api/v3/repos/${full}/pulls{/number}`,
    releases_url: `${baseUrl}/api/v3/repos/${full}/releases{/id}`,
    ssh_url: `git@localhost:${full}.git`,
    stargazers_url: `${baseUrl}/api/v3/repos/${full}/stargazers`,
    statuses_url: `${baseUrl}/api/v3/repos/${full}/statuses/{sha}`,
    subscribers_url: `${baseUrl}/api/v3/repos/${full}/subscribers`,
    subscription_url: `${baseUrl}/api/v3/repos/${full}/subscription`,
    tags_url: `${baseUrl}/api/v3/repos/${full}/tags`,
    teams_url: `${baseUrl}/api/v3/repos/${full}/teams`,
    trees_url: `${baseUrl}/api/v3/repos/${full}/git/trees{/sha}`,
    clone_url: `${baseUrl}/${full}.git`,
    mirror_url: null,
    hooks_url: `${baseUrl}/api/v3/repos/${full}/hooks`,
    svn_url: `${baseUrl}/${full}`,
    homepage: null,
    language: null,
    forks_count: 0,
    forks: 0,
    stargazers_count: 0,
    watchers_count: 0,
    watchers: 0,
    size: 0,
    default_branch: repo.defaultBranch,
    open_issues_count: [...repo.threads.values()].filter((thread) => thread.state === 'open').length,
    open_issues: 0,
    is_template: false,
    topics: [],
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    pushed_at: repo.pushedAt,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    network_count: 0,
    subscribers_count: 0,
  };
}

export function threadJson(thread: Thread, repo: Repo, baseUrl: string) {
  return isPull(thread) ? pullJson(thread, repo, baseUrl) : issueJson(thread, repo, baseUrl);
}

export function issueJson(thread: Thread, repo: Repo, baseUrl: string) {
  const url = `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${thread.number}`;
  return {
    id: thread.id,
    node_id: `I_${repo.id}_${thread.number}`,
    url,
    repository_url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `${url}/labels{/name}`,
    comments_url: `${url}/comments`,
    events_url: `${url}/events`,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/issues/${thread.number}`,
    number: thread.number,
    state: thread.state,
    state_reason: thread.closedAt === null ? null : 'completed',
    title: thread.title,
    body: thread.body,
    user: userJson(thread.user),
    labels: thread.labels.map((label) => labelJson(label)),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    active_lock_reason: null,
    comments: thread.comments.length,
    created_at: thread.createdAt,
    updated_at: thread.updatedAt,
    closed_at: thread.closedAt,
    author_association: 'OWNER',
    drafted: false,
  };
}

export function pullJson(pull: Pull, repo: Repo, baseUrl: string) {
  const base = issueJson(pull, repo, baseUrl);
  const headSha = branchTip(repo, pull.head) ?? '';
  const baseSha = branchTip(repo, pull.base) ?? '';
  const full = `${repo.owner}/${repo.name}`;
  return {
    ...base,
    node_id: `P_${repo.id}_${pull.number}`,
    url: `${baseUrl}/api/v3/repos/${full}/pulls/${pull.number}`,
    html_url: `${baseUrl}/${full}/pull/${pull.number}`,
    issue_url: `${baseUrl}/api/v3/repos/${full}/issues/${pull.number}`,
    statuses_url: `${baseUrl}/api/v3/repos/${full}/statuses/${headSha}`,
    diff_url: `${baseUrl}/${full}/pull/${pull.number}.diff`,
    patch_url: `${baseUrl}/${full}/pull/${pull.number}.patch`,
    commits_url: `${baseUrl}/api/v3/repos/${full}/pulls/${pull.number}/commits`,
    review_comments_url: `${baseUrl}/api/v3/repos/${full}/pulls/${pull.number}/comments`,
    review_comment_url: `${baseUrl}/api/v3/repos/${full}/pulls/comments{/number}`,
    comments_url: `${baseUrl}/api/v3/repos/${full}/issues/${pull.number}/comments`,
    _links: {},
    head: { label: `${repo.owner}:${pull.head}`, ref: pull.head, sha: headSha, user: userJson(repo.owner), repo: repoSummary(repo, baseUrl) },
    base: { label: `${repo.owner}:${pull.base}`, ref: pull.base, sha: baseSha, user: userJson(repo.owner), repo: repoSummary(repo, baseUrl) },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    mergeable: true,
    mergeable_state: 'clean',
    merged_by: pull.merged ? userJson(VIEWER.login) : null,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    maintainer_can_modify: true,
    rebaseable: true,
  };
}

function repoSummary(repo: Repo, baseUrl: string) {
  const full = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    name: repo.name,
    full_name: full,
    private: repo.private,
    owner: userJson(repo.owner),
    html_url: `${baseUrl}/${full}`,
    description: repo.description,
    default_branch: repo.defaultBranch,
    url: `${baseUrl}/api/v3/repos/${full}`,
    clone_url: `${baseUrl}/${full}.git`,
  };
}

export function commentJson(comment: Comment, baseUrl: string) {
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    url: `${baseUrl}/api/v3/repos/${VIEWER.login}/comments/${comment.id}`,
    html_url: `${baseUrl}/#comment-${comment.id}`,
    issue_url: '',
    author_association: 'OWNER',
  };
}

// ---------------------------------------------------------------------------------------------
// helpers

function notFound(): RestResult {
  return { status: 404, body: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' } };
}

function normalisePath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '');
}

/** GitHub's REST commit objects carry the message without git's trailing newline. */
function trimMessage(message: string): string {
  return message.replace(/\n+$/, '');
}

function branchName(value: string): string {
  const colon = value.indexOf(':');
  return colon === -1 ? value : value.slice(colon + 1);
}

function clampPerPage(raw: string | null): number {
  const value = Number(raw ?? '30');
  if (!Number.isInteger(value) || value <= 0) return 30;
  return Math.min(100, value);
}

function hash(text: string): number {
  let value = 0;
  for (let index = 0; index < text.length; index += 1) value = (value * 31 + text.charCodeAt(index)) % 2_000_000_000;
  return value + 1;
}

function authorName(line: string): string {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  return match === null ? line : match[1]!;
}

function authorEmail(line: string): string {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  return match === null ? '' : match[2]!;
}

function timestampOf(line: string): string {
  const match = /(\d+) ([+-]\d{4})$/.exec(line);
  const epoch = match === null ? 0 : Number(match[1]);
  return new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export { branchTip, flattenTree, isAncestor, commitFiles, resolveCommitish };

