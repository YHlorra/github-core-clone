// Git's smart HTTP endpoints: the protocol-v2 advertisement and its ls-refs/fetch commands, the v0
// receive-pack advertisement and push processing, and the packfile plumbing behind both. The server
// keeps objects in memory keyed by SHA-1, so a push and a clone are just map operations plus framing.

import { ZERO_OID, collectReachable, hashObject, isObjectType, parseCommit, parseTag, type GitObject } from './git-objects.ts';
import { isAncestor, readPack, writePack } from './pack.ts';
import { decodePktLines, encodePktLine, encodePktLines, pktLineDelim, pktLineFlush, splitAfterFlush, type Packet } from './pktline.ts';
import { branchTip, lookup, type Forge, type Repo } from './model.ts';

export interface GitHttpRequest {
  forge: Forge;
  method: string;
  owner: string;
  repo: string;
  /** Path segments after `/{owner}/{repo}.git`. */
  rest: string[];
  query: URLSearchParams;
  body: Buffer;
  baseUrl: string;
  authed: boolean;
  /** The `Git-Protocol` request header, when the client sent one. */
  protocolHeader?: string;
}

export interface GitHttpResponse {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

const UPLOAD = 'git-upload-pack';
const RECEIVE = 'git-receive-pack';
const AGENT = 'ghclone/1.0';

/** `/{owner}/{repo}.git/...` → its parts, or null when the path is not a git endpoint. */
export function parseGitPath(segments: string[]): { owner: string; repo: string; rest: string[] } | null {
  if (segments.length < 2) return null;
  const second = segments[1]!;
  if (!second.endsWith('.git')) return null;
  const repo = second.slice(0, -'.git'.length);
  if (repo === '') return null;
  return { owner: segments[0]!, repo, rest: segments.slice(2) };
}

export async function handleGitHttp(req: GitHttpRequest): Promise<GitHttpResponse> {
  const repo = req.forge.find(req.owner, req.repo);
  if (repo === undefined) return plain(404, 'Not Found');
  const rest = req.rest;
  if (rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
    const service = req.query.get('service') ?? UPLOAD;
    if (service !== UPLOAD && service !== RECEIVE) return plain(404, 'Not Found');
    return advertise(repo, service, req.protocolHeader);
  }
  if (rest.length === 1 && rest[0] === UPLOAD && req.method === 'POST') {
    return uploadPack(req, repo);
  }
  if (rest.length === 1 && rest[0] === RECEIVE && req.method === 'POST') {
    return receivePack(req, repo);
  }
  return plain(404, 'Not Found');
}

function plain(status: number, message: string): GitHttpResponse {
  return { status, contentType: 'text/plain; charset=utf-8', body: Buffer.from(`${message}\n`, 'utf8') };
}

function result(contentType: string, body: Buffer): GitHttpResponse {
  return { status: 200, contentType, body, headers: { 'cache-control': 'no-cache, max-age=0, must-revalidate', pragma: 'no-cache' } };
}

// ---------------------------------------------------------------------------------------------
// advertisements

const V0_UPLOAD_CAPS = [
  'multi_ack',
  'thin-pack',
  'side-band',
  'side-band-64k',
  'ofs-delta',
  'shallow',
  'deepen-since',
  'deepen-not',
  'filter',
  'object-format=sha1',
  `agent=${AGENT}`,
  'symref=HEAD:refs/heads/main',
].join(' ');

const V0_RECEIVE_CAPS = [
  'report-status',
  'report-status-v2',
  'delete-refs',
  'side-band-64k',
  'quiet',
  'atomic',
  'ofs-delta',
  'object-format=sha1',
  `agent=${AGENT}`,
].join(' ');

/** Every ref as `[name, oid]`, sorted with `refs/heads/*` before `refs/tags/*`. */
function allRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()]
    .filter(([name]) => name.startsWith('refs/'))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function headOid(repo: Repo): string | undefined {
  return branchTip(repo, repo.defaultBranch);
}

function peelOf(repo: Repo, oid: string): string | undefined {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return undefined;
  let current = parseTag(object.data).object;
  for (let depth = 0; depth < 16; depth += 1) {
    const next = repo.objects.get(current);
    if (next === undefined) return current;
    if (next.type !== 'tag') return current;
    current = parseTag(next.data).object;
  }
  return current;
}

function v0Advertisement(repo: Repo, service: string): Buffer {
  const caps = service === UPLOAD ? V0_UPLOAD_CAPS : V0_RECEIVE_CAPS;
  const refs = allRefs(repo);
  const lines: (string | 'flush')[] = [`# service=${service}\n`, 'flush'];
  const head = headOid(repo);
  const first: { name: string; oid: string }[] = head === undefined ? [] : [{ name: 'HEAD', oid: head }];
  for (const [name, oid] of refs) first.push({ name, oid });
  if (first.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\u0000${caps}\n`);
  } else {
    first.forEach((ref, index) => {
      const suffix = index === 0 ? `\u0000${caps}` : '';
      lines.push(`${ref.oid} ${ref.name}${suffix}\n`);
      if (ref.name.startsWith('refs/tags/')) {
        const peeled = peelOf(repo, ref.oid);
        if (peeled !== undefined) lines.push(`${peeled} ${ref.name}^{}\n`);
      }
    });
  }
  lines.push('flush');
  return encodePktLines(lines);
}

function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'object-format=sha1\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done filter\n',
    'server-option\n',
    'object-info\n',
    'flush',
  ]);
}

function advertise(repo: Repo, service: string, protocolHeader: string | undefined): GitHttpResponse {
  const v2 = service === UPLOAD && protocolHeader !== undefined && /(?:^|\s)version=2(?:\s|$)/.test(protocolHeader);
  const contentType = `application/x-${service}-advertisement`;
  if (v2) return result(contentType, v2Advertisement());
  return result(contentType, v0Advertisement(repo, service));
}

// ---------------------------------------------------------------------------------------------
// protocol v2 requests

interface V2Request {
  command: string;
  args: string[];
}

function parseV2Request(body: Buffer): V2Request {
  const packets = decodePktLines(body).filter((packet) => packet.kind === 'data');
  const lines = packets.map((packet) => packet.payload.toString('utf8').replace(/\n$/, ''));
  const command = (lines.shift() ?? '').replace(/^command=/, '');
  return { command, args: lines };
}

function uploadPack(req: GitHttpRequest, repo: Repo): GitHttpResponse {
  const body = req.body;
  let request: V2Request;
  try {
    request = parseV2Request(body);
  } catch {
    return plain(200, 'error: malformed request');
  }
  const contentType = 'application/x-git-upload-pack-result';
  if (request.command === 'ls-refs') {
    return result(contentType, lsRefs(repo, request.args));
  }
  if (request.command === 'fetch') {
    return result(contentType, fetch(repo, request.args));
  }
  if (request.command === 'object-info') {
    return result(contentType, encodePktLines(['flush']));
  }
  // A v0 upload-pack request (want/have lines) has no command line; answer it in v0 framing.
  return result(contentType, fetchV0(repo, body));
}

function lsRefsArgs(args: string[]): { prefixes: string[]; peel: boolean; symrefs: boolean; unborn: boolean } {
  const out = { prefixes: [] as string[], peel: false, symrefs: false, unborn: false };
  for (const arg of args) {
    if (arg === 'peel') out.peel = true;
    else if (arg === 'symrefs') out.symrefs = true;
    else if (arg === 'unborn') out.unborn = true;
    else if (arg.startsWith('ref-prefix ')) out.prefixes.push(arg.slice('ref-prefix '.length));
  }
  return out;
}

function lsRefs(repo: Repo, args: string[]): Buffer {
  const options = lsRefsArgs(args);
  const keep = (name: string): boolean => options.prefixes.length === 0 || options.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: (string | 'flush')[] = [];
  const head = headOid(repo);
  const headName = `refs/heads/${repo.defaultBranch}`;
  if (head !== undefined && (options.prefixes.length === 0 || options.prefixes.some((prefix) => 'HEAD'.startsWith(prefix) || prefix.startsWith('HEAD')))) {
    const attrs = options.symrefs ? ` symref-target:${headName}` : '';
    lines.push(`${head} HEAD${attrs}\n`);
  } else if (head === undefined && options.unborn) {
    const attrs = options.symrefs ? ` symref-target:${headName}` : '';
    lines.push(`unborn HEAD${attrs}\n`);
  }
  for (const [name, oid] of allRefs(repo)) {
    if (!keep(name)) continue;
    let attrs = '';
    if (name.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (options.symrefs) attrs += '';
      if (options.peel && object?.type === 'tag') {
        const peeled = peelOf(repo, oid);
        if (peeled !== undefined) attrs += ` peeled:${peeled}`;
      }
    }
    lines.push(`${oid} ${name}${attrs}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

function fetchArgs(args: string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) out.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) out.depth = Number(arg.slice(7).trim());
    else if (arg === 'done') out.done = true;
  }
  return out;
}

/** Every tree and blob under `treeOid`, added to `out`. */
function addTreeClosure(repo: Repo, treeOid: string, out: Set<string>): void {
  if (out.has(treeOid)) return;
  const object = repo.objects.get(treeOid);
  if (object === undefined) return;
  out.add(treeOid);
  if (object.type !== 'tree') return;
  for (const entry of treeEntries(object.data)) {
    if (entry.mode === '40000' || entry.mode === '040000') addTreeClosure(repo, entry.oid, out);
    else if (!out.has(entry.oid)) out.add(entry.oid);
  }
}

function treeEntries(data: Buffer): { mode: string; name: string; oid: string }[] {
  // Local import-free parse to keep this module independent of the tree helper's ordering rules.
  const entries: { mode: string; name: string; oid: string }[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/**
 * The objects a fetch must deliver: everything reachable from the wants (stopping one short of the
 * requested depth), minus everything the client already holds. A shallow `have` is a boundary: the
 * client holds that commit but none of its ancestors, so the walk stops there.
 */
function selectObjects(repo: Repo, args: FetchArgs): { objects: string[]; shallow: string[] } {
  const wantCommits: string[] = [];
  const extraTags: string[] = [];
  for (const want of args.wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      extraTags.push(want);
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject !== undefined && targetObject.type === 'commit') wantCommits.push(target);
      else if (targetObject !== undefined && targetObject.type === 'tag') extraTags.push(target);
    } else if (object.type === 'commit') {
      wantCommits.push(want);
    }
  }

  const included = new Set<string>();
  const shallow: string[] = [];
  const depth = args.depth !== null && Number.isFinite(args.depth) && args.depth > 0 ? args.depth : null;
  const seenDepth = new Map<string, number>();
  let frontier: { oid: string; dist: number }[] = wantCommits.map((oid) => ({ oid, dist: 0 }));
  while (frontier.length > 0) {
    const next: { oid: string; dist: number }[] = [];
    for (const item of frontier) {
      const previous = seenDepth.get(item.oid);
      if (previous !== undefined && previous <= item.dist) continue;
      seenDepth.set(item.oid, item.dist);
      const object = repo.objects.get(item.oid);
      if (object === undefined || object.type !== 'commit') continue;
      included.add(item.oid);
      addTreeClosure(repo, parseCommit(object.data).tree, included);
      const parents = parseCommit(object.data).parents;
      const atBoundary = depth !== null && item.dist + 1 >= depth;
      if (atBoundary) {
        if (parents.length > 0) shallow.push(item.oid);
        continue;
      }
      for (const parent of parents) next.push({ oid: parent, dist: item.dist + 1 });
    }
    frontier = next;
  }
  for (const tag of extraTags) included.add(tag);

  const held = new Set<string>();
  const shallowHaves = new Set(args.shallow);
  for (const have of args.haves) {
    const object = repo.objects.get(have);
    if (object === undefined) continue;
    held.add(have);
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject !== undefined && targetObject.type === 'commit') held.add(target);
      continue;
    }
    if (object.type !== 'commit') continue;
    addTreeClosure(repo, parseCommit(object.data).tree, held);
    if (shallowHaves.has(have)) continue;
    let parents = parseCommit(object.data).parents;
    while (parents.length > 0) {
      const parent = parents[0]!;
      const parentObject = repo.objects.get(parent);
      if (parentObject === undefined || parentObject.type !== 'commit') break;
      held.add(parent);
      addTreeClosure(repo, parseCommit(parentObject.data).tree, held);
      if (shallowHaves.has(parent)) break;
      parents = parseCommit(parentObject.data).parents;
    }
  }

  const objects: string[] = [];
  for (const oid of included) if (!held.has(oid)) objects.push(oid);
  return { objects, shallow };
}

function fetch(repo: Repo, args: string[]): Buffer {
  const parsed = fetchArgs(args);
  if (parsed.wants.length === 0) {
    return encodePktLines(['acknowledgments\n', 'NAK\n', 'flush']);
  }
  const { objects, shallow } = selectObjects(repo, parsed);
  const lines: (string | 'flush')[] = ['acknowledgments\n'];
  if (parsed.haves.length > 0) {
    lines.push(`ACK ${parsed.haves[0]}\n`, 'ready\n');
  } else {
    lines.push('NAK\n');
  }
  lines.push('flush');
  if (shallow.length > 0) {
    lines.push('shallow-info\n');
    for (const oid of shallow) lines.push(`shallow ${oid}\n`);
    lines.push('flush');
  }
  lines.push('packfile\n');
  const parts: Buffer[] = [encodePktLines(lines)];
  const pack = writePack(objects.map((oid) => repo.objects.get(oid)!).filter((object) => object !== undefined));
  parts.push(sideband(1, pack));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

/** Split `data` into band-`band` pkt-lines. */
function sideband(band: number, data: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const size = 32 * 1024;
  for (let offset = 0; offset < data.length; offset += size) {
    const slice = data.subarray(offset, Math.min(offset + size, data.length));
    chunks.push(encodePktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  return Buffer.concat(chunks);
}

/** A v0 upload-pack request: `want` lines then a pack in the response. */
function fetchV0(repo: Repo, body: Buffer): Buffer {
  let args: string[] = [];
  try {
    args = decodePktLines(body)
      .filter((packet) => packet.kind === 'data')
      .map((packet) => packet.payload.toString('utf8').replace(/\n$/, ''));
  } catch {
    return encodePktLines(['NAK\n']);
  }
  const wanted = args.filter((line) => line.startsWith('want ')).map((line) => line.slice(5).trim());
  const haves = args.filter((line) => line.startsWith('have ')).map((line) => line.slice(5).trim());
  if (wanted.length === 0) return encodePktLines(['NAK\n']);
  const { objects } = selectObjects(repo, { wants: wanted, haves, shallow: [], depth: null, done: true });
  const pack = writePack(objects.map((oid) => repo.objects.get(oid)!).filter((object) => object !== undefined));
  return Buffer.concat([encodePktLines(['NAK\n']), sideband(1, pack), pktLineFlush()]);
}

// ---------------------------------------------------------------------------------------------
// receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(req: GitHttpRequest, repo: Repo): GitHttpResponse {
  const contentType = 'application/x-git-receive-pack-result';
  let header: Buffer;
  let pack: Buffer;
  try {
    const split = splitAfterFlush(req.body);
    header = split.header;
    pack = split.rest;
  } catch {
    return plain(400, 'error: malformed receive-pack request');
  }

  const commands: PushCommand[] = [];
  let wantsSideband = false;
  try {
    for (const packet of decodePktLines(header)) {
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = text.indexOf('\u0000');
      if (nul >= 0 && text.slice(nul + 1).split(' ').includes('side-band-64k')) wantsSideband = true;
      const line = nul >= 0 ? text.slice(0, nul) : text;
      const parts = line.split(' ');
      if (parts.length >= 3) commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
  } catch {
    return plain(400, 'error: malformed receive-pack request');
  }

  let unpack = 'ok';
  if (pack.length > 0) {
    try {
      const read = readPack(pack, (oid) => repo.objects.get(oid));
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (error) {
      unpack = `ng ${error instanceof Error ? error.message : 'unpacker error'}`;
    }
  }

  const report: string[] = [`unpack ${unpack}\n`];
  if (unpack === 'ok') {
    for (const command of commands) {
      const verdict = applyPush(repo, command);
      if (verdict === null) report.push(`ok ${command.ref}\n`);
      else report.push(`ng ${command.ref} ${verdict}\n`);
    }
    repo.pushedAt = new Date().toISOString();
  } else {
    for (const command of commands) report.push(`ng ${command.ref} unpacker error\n`);
  }
  report.push('flush');

  const reportBytes = encodePktLines(report);
  if (!wantsSideband) return result(contentType, reportBytes);
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < reportBytes.length; offset += 32 * 1024) {
    const slice = reportBytes.subarray(offset, Math.min(offset + 32 * 1024, reportBytes.length));
    chunks.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  chunks.push(pktLineFlush());
  return result(contentType, Buffer.concat(chunks));
}

/** Apply one push command; null when accepted, otherwise the refusal reason. */
function applyPush(repo: Repo, command: PushCommand): string | null {
  const current = repo.refs.get(command.ref);
  const isBranch = command.ref.startsWith('refs/heads/');
  if (command.newOid === ZERO_OID) {
    if (current === undefined) return null;
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) return 'stale info';
    repo.refs.delete(command.ref);
    return null;
  }
  if (!repo.objects.has(command.newOid)) return 'missing necessary objects';
  if (current !== undefined) {
    if (command.oldOid !== current) return 'stale info';
    if (isBranch && command.oldOid !== command.newOid && !isAncestor(command.oldOid, command.newOid, lookup(repo))) {
      return 'non-fast-forward';
    }
  } else if (command.oldOid !== ZERO_OID) {
    return 'stale info';
  }
  repo.refs.set(command.ref, command.newOid);
  return null;
}

// Keep the imports this module promises to its callers type-checked without a bundler step.
export { hashObject, isObjectType, collectReachable, pktLineDelim, type Packet, type GitObject };
