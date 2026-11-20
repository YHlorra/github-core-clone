// Git's object model: the four object types, their ids (SHA-1 over `<type> <size>\0` plus the bytes),
// and the tree/commit/tag byte formats. Trees are stored the way git stores them — `<mode> <name>\0`
// followed by the 20 raw bytes of the entry's id — so an object this module builds hashes to exactly
// the id the suite's own builders produce for the same content.

import { createHash } from 'node:crypto';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export function isObjectType(value: string): value is ObjectType {
  return value === 'commit' || value === 'tree' || value === 'blob' || value === 'tag';
}

/** The object id git gives `data` as a `type` object. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\u0000`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

const SHA40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return SHA40.test(value);
}

export const ZERO_OID = '0'.repeat(40);

// ---------------------------------------------------------------------------------------------
// trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Whether a tree mode names a directory. */
export function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Parse a tree object's bytes into its entries, in storage order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode terminator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > data.length) throw new Error('tree entry has a truncated object id');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: names as byte strings, with a directory's name read as `name/`. */
function treeSortKey(entry: TreeEntry): string {
  return `${entry.name}${isTreeMode(entry.mode) ? '/' : ''}`;
}

/** Build a tree object's bytes from entries (ordered as git orders them). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    const mode = entry.mode === '040000' ? '40000' : entry.mode;
    parts.push(Buffer.from(`${mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// commits

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's bytes. Header lines run to the first blank line; the rest is the message. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (tree === '') throw new Error('commit object has no tree');
  return { tree, parents, author, committer, message };
}

export interface Identity {
  name: string;
  email: string;
}

/** `<name> <email> <epoch seconds> +0000`, the line git writes for an author or committer. */
export function identityLine(identity: Identity, epochSec: number): string {
  return `${identity.name} <${identity.email}> ${Math.trunc(epochSec)} +0000`;
}

export interface CommitFields {
  tree: string;
  parents: readonly string[];
  message: string;
  identity: Identity;
  epochSec: number;
}

/** Build a commit object's bytes; the message keeps whatever trailing newline the caller supplied. */
export function buildCommit(fields: CommitFields): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  const stamped = identityLine(fields.identity, fields.epochSec);
  lines.push(`author ${stamped}`, `committer ${stamped}`);
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

// ---------------------------------------------------------------------------------------------
// tags

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Follow tag objects down to the object they ultimately name. */
export function peelTag(oid: string, lookup: (id: string) => GitObject | undefined): string {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = lookup(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

// ---------------------------------------------------------------------------------------------
// ranges

/**
 * Every object reachable from `roots`: commit → its tree → the tree's entries recursively, commits →
 * their parents, tags → their targets. Deterministic order (depth first, parents in order).
 */
export function collectReachable(roots: Iterable<string>, lookup: (oid: string) => GitObject | undefined): Set<string> {
  const seen = new Set<string>();
  const visit = (oid: string): void => {
    if (seen.has(oid)) return;
    const object = lookup(oid);
    if (object === undefined) throw new Error(`missing object ${oid}`);
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      visit(commit.tree);
      for (const parent of commit.parents) visit(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) visit(entry.oid);
    } else if (object.type === 'tag') {
      visit(parseTag(object.data).object);
    }
  };
  for (const root of roots) visit(root);
  return seen;
}
