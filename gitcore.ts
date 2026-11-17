// gitcore.ts — the git object model, pack codec and pkt-line framing.
//
// Byte-exactness matters: the harness clones the forge's objects and
// re-hashes them, so every object the server stores or serves must be
// hashed over `<type> <size>\0` + payload, trees must be sorted git-style
// (directory names compared as if ending in '/'), and packs must be
// well-formed `PACK` v2 with a SHA-1 trailer.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX = 65520;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`, 'latin1');
  h.update(data);
  return h.digest('hex');
}

export function objectId(type: GitObjectType, data: Buffer): string {
  return hashObject(type, data);
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const header = Buffer.alloc(4);
  header.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

export interface PktDecodeResult {
  packets: PktPacket[];
  /** Byte offset in the input where the first non-pkt-line byte begins
   * (e.g. the start of a pack after a flush), or the input length. */
  restOffset: number;
}

/** Decode ALL pkt-lines in `buf` (flush/delim are packets, not terminators).
 * Use for requests that are entirely pkt-lines (v0/v2 fetch, v2 ls-refs). */
export function decodeAllPktLines(buf: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) break;
    const len = parseInt(lenHex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: Buffer.from(buf.subarray(off + 4, off + len)) });
    off += len;
  }
  return packets;
}
export function decodePktLines(buf: Buffer): PktDecodeResult {
  const packets: PktPacket[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) break;
    const len = parseInt(lenHex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      break;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: Buffer.from(buf.subarray(off + 4, off + len)) });
    off += len;
  }
  return { packets, restOffset: off };
}

// ---------------------------------------------------------------------------
// trees / commits / tags
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string; // '100644', '100755', '120000', '40000', '160000'
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp);
    const mode = data.subarray(off, sp).toString('ascii');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0,
  );
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface CommitInput {
  tree: string;
  parents: string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
}

export function buildCommit(input: CommitInput): Buffer {
  const ts = input.timestamp ?? Math.floor(Date.now() / 1000);
  const identity = input.author ?? 'Conformance <conformance@make.fun>';
  const committer = input.committer ?? identity;
  const msg = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  const lines: string[] = [`tree ${input.tree}`];
  for (const p of input.parents) lines.push(`parent ${p}`);
  lines.push(`author ${identity} ${ts} +0000`);
  lines.push(`committer ${committer} ${ts} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${msg}`, 'utf8');
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** Full closure of `roots`: every commit, tag, tree and blob reachable. */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  allowMissing = false,
): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) {
      if (allowMissing) continue;
      throw new Error(`object not found: ${oid}`);
    }
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// packs
// ---------------------------------------------------------------------------

const PACK_TYPE = { commit: 1, tree: 2, blob: 3, tag: 4, ofs_delta: 6, ref_delta: 7 } as const;
const PACK_TYPE_NAME: Record<number, GitObjectType | 'ofs_delta' | 'ref_delta'> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs_delta',
  7: 'ref_delta',
};

export function writePack(objects: Iterable<GitObject>): Buffer {
  const entries: Buffer[] = [];
  let count = 0;
  for (const obj of objects) {
    const typeNum = PACK_TYPE[obj.type as keyof typeof PACK_TYPE];
    const data = obj.data;
    let size = data.length;
    const headerBytes: number[] = [];
    let first = (typeNum << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) first |= 0x80;
    headerBytes.push(first);
    while (size > 0) {
      let b = size & 0x7f;
      size >>= 7;
      if (size > 0) b |= 0x80;
      headerBytes.push(b);
    }
    entries.push(Buffer.from(headerBytes));
    entries.push(deflateSync(data));
    count++;
  }
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(count, 8);
  const body = Buffer.concat([header, ...entries]);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Parse a pack. Plain objects only — the harness never sends deltas.
 * Each entry's compressed length is found by binary search over the
 * minimal slice that inflates cleanly (inflateSync ignores trailing
 * bytes and throws on truncation). */
export function readPack(pack: Buffer): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  if (pack.length < 32) throw new Error('pack too small');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack');
  if (pack.readUInt32BE(4) !== 2) throw new Error('unsupported pack version');
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const bodyHash = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!bodyHash.equals(trailer)) throw new Error('pack checksum mismatch');
  let off = 12;
  for (let i = 0; i < count; i++) {
    if (off >= pack.length - 20) throw new Error('pack truncated');
    let byte = pack[off++];
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[off++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const typeName = PACK_TYPE_NAME[typeNum];
    if (!typeName) throw new Error(`unknown pack object type ${typeNum}`);
    if (typeName === 'ofs_delta' || typeName === 'ref_delta') {
      throw new Error('delta pack not supported (client never sends deltas)');
    }
    const { data, consumed } = inflateAt(pack, off);
    off += consumed;
    if (data.length !== size) throw new Error('pack object size mismatch');
    const oid = hashObject(typeName, data);
    out.set(oid, { type: typeName, data });
  }
  return out;
}

/** Inflate a zlib stream starting at `off`; returns the data and the number
 * of compressed bytes consumed. */
export function inflateAt(buf: Buffer, off: number): { data: Buffer; consumed: number } {
  // Use inflateSync on a growing slice is expensive; instead use zlib's
  // inflate with a streaming API is not available synchronously, so we
  // binary-search the minimal length that inflates cleanly.
  let lo = 1;
  let hi = buf.length - off;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const data = inflateSync(buf.subarray(off, off + mid));
      best = mid;
      hi = mid - 1;
      void data;
    } catch {
      lo = mid + 1;
    }
  }
  if (best === -1) throw new Error('inflate failed');
  const data = inflateSync(buf.subarray(off, off + best));
  return { data, consumed: best };
}
