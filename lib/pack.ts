// Packfile reading and writing on node:zlib. Reading handles the three entry encodings a client may
// send (a whole object, an OFS_DELTA against an earlier offset, a REF_DELTA against an object id) and
// verifies the trailing SHA-1. Writing emits whole objects only — legal, and the suite verifies object
// bytes rather than deltas.

import { createHash } from 'node:crypto';
import { constants as zlibConstants, deflateSync, inflateSync } from 'node:zlib';
import { hashObject, parseTree, parseCommit, parseTag, type GitObject, type ObjectType } from './git-objects.ts';

const TYPE_CODE: Readonly<Record<number, ObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const CODE_TYPE: Readonly<Record<ObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export interface PackEntry {
  offset: number;
  typeCode: number;
  /** The declared size of the entry's payload (after delta application for a delta entry). */
  size: number;
  /** The object id, once resolved. */
  oid: string;
}

export interface PackReadResult {
  version: number;
  declaredCount: number;
  entries: PackEntry[];
  deltaCount: number;
  objects: Map<string, GitObject>;
}

/** Inflate one zlib stream starting at `offset`; `next` is the offset just past it. */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply git's delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
      if (shift > 56) throw new Error('delta size varint is too long');
    }
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/** The SHA-1 of every pack byte before the 20-byte trailer. */
export function packChecksum(pack: Buffer): string {
  return createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
}

/** Verify a pack's trailer against its bytes. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  if (pack.length < 20) return { ok: false, expected: '', actual: '' };
  const actual = pack.subarray(pack.length - 20).toString('hex');
  return { ok: packChecksum(pack) === actual, expected: packChecksum(pack), actual };
}

/**
 * Read a packfile. Deltas are applied as they are read: an OFS_DELTA resolves against an object seen
 * earlier in the pack, a REF_DELTA against the pack or `resolveBase` (a thin pack's missing base).
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('body is not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailer = verifyPackChecksum(pack);
  if (!trailer.ok) throw new Error(`pack trailer ${trailer.actual} does not match its bytes ${trailer.expected}`);

  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  const entries: PackEntry[] = [];
  let deltaCount = 0;
  let offset = 12;

  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    if (offset >= pack.length - 20) throw new Error(`pack declares ${declaredCount} objects but ends after ${index}`);
    let byte = pack[offset++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 56) throw new Error('pack entry size varint is too long');
    }
    let baseOffset = -1;
    let baseOid: string | null = null;
    if (typeCode === 6) {
      let value = 0;
      let c = pack[offset++];
      value = c & 0x7f;
      while ((c & 0x80) !== 0) {
        c = pack[offset++];
        value = (value + 1) * 128 + (c & 0x7f);
      }
      baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (TYPE_CODE[typeCode] === undefined) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack, offset);
    offset = inflated.next;

    let type: ObjectType;
    let data: Buffer;
    if (typeCode === 6 || typeCode === 7) {
      deltaCount += 1;
      let base: GitObject | undefined;
      if (baseOffset >= 0) base = byOffset.get(baseOffset);
      else if (baseOid !== null) base = objects.get(baseOid) ?? resolveBase?.(baseOid);
      if (base === undefined) throw new Error(`delta entry at offset ${entryOffset} has no resolvable base`);
      type = base.type;
      data = applyDelta(base.data, inflated.data);
    } else {
      type = TYPE_CODE[typeCode]!;
      data = inflated.data;
      if (data.length !== size) throw new Error(`pack entry at offset ${entryOffset} declares ${size} bytes, inflated ${data.length}`);
    }
    const oid = hashObject(type, data);
    const object: GitObject = { type, data };
    objects.set(oid, object);
    byOffset.set(entryOffset, object);
    entries.push({ offset: entryOffset, typeCode, size: data.length, oid });
  }

  return { version, declaredCount, entries, deltaCount, objects };
}

function objectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(first | 0x80);
    first = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Write a packfile holding whole objects (no deltas), trailer included. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const parts: Buffer[] = [];
  const list = [...objects];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(objectHeader(CODE_TYPE[object.type], object.data.length));
    parts.push(deflateSync(object.data, { level: zlibConstants.Z_DEFAULT_COMPRESSION }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Whether `ancestor` is reachable from `tip` through commit parents. Linear histories answer on the
 * first step (the common push case); a branch that rewrote history costs a walk.
 */
export function isAncestor(
  ancestor: string,
  tip: string,
  lookup: (oid: string) => GitObject | undefined,
): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  let frontier = [tip];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = lookup(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === ancestor) return true;
        next.push(parent);
      }
    }
    frontier = next;
  }
  return false;
}

/** A tree's entries as `path → { mode, oid }`, flattened through its subtrees. */
export function flattenTree(
  root: string,
  lookup: (oid: string) => GitObject | undefined,
  prefix = '',
): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const object = lookup(root);
  if (object === undefined) return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000' || entry.mode === '040000') {
      for (const [key, value] of flattenTree(entry.oid, lookup, path)) out.set(key, value);
    } else {
      out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  }
  return out;
}

/** The commit at `oid`, or null when the object is absent or not a commit. */
export function readCommit(lookup: (oid: string) => GitObject | undefined, oid: string) {
  const object = lookup(oid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data);
}

/** The tree entries of a commit, or an empty list when it cannot be read. */
export function treeOfCommit(lookup: (oid: string) => GitObject | undefined, commitOid: string) {
  const commit = readCommit(lookup, commitOid);
  if (commit === null) return [];
  const object = lookup(commit.tree);
  if (object === undefined || object.type !== 'tree') return [];
  return parseTree(object.data);
}

/** Follow a tag chain down to the commit it names, when it names one. */
export function commitOfTag(lookup: (oid: string) => GitObject | undefined, oid: string): string | null {
  let current: string | null = oid;
  for (let depth = 0; depth < 16 && current !== null; depth += 1) {
    const object = lookup(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
  }
  return null;
}
