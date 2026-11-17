// gitproto.ts — the git smart-HTTP protocol (upload-pack v2/v0, receive-pack).
//
// This is the heart of the forge: a byte-exact implementation of the
// protocol the harness speaks. Key contracts (from the kit's git-client):
//  - v0 advertisement opens with `# service=git-upload-pack` /
//    `# service=git-receive-pack`; v2 opens with `version 2`.
//  - v2 advertisement must carry ls-refs=unborn, fetch=shallow and
//    object-format=sha1.
//  - receive-pack advertises report-status, side-band-64k, delete-refs
//    and NOT report-status-v2.
//  - A fetch that has nothing to send must OMIT the packfile section.
//  - deepen N is the TOTAL depth from the wants; boundary commits
//    (distance N-1) get `shallow` lines; client-shallow commits that
//    are now interior get `unshallow` lines.

import {
  decodeAllPktLines,
  decodePktLines,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  writePack,
  ZERO_OID,
} from './gitcore.ts';
import type { GitObject, PktPacket } from './gitcore.ts';
import type { Repo, Store } from './store.ts';

export interface GitReply {
  status: number;
  body: Buffer;
  contentType: string;
}

const AGENT = 'github-core-clone/1.0';

function gitReply(status: number, body: Buffer, contentType: string): GitReply {
  return { status, body, contentType };
}

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The commit an annotated tag points to (peeling recursively), else null. */
function peeledCommit(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  let target = parseTag(obj.data).object;
  for (let i = 0; i < 8; i++) {
    const t = repo.objects.get(target);
    if (!t) return null;
    if (t.type === 'commit') return target;
    if (t.type === 'tag') target = parseTag(t.data).object;
    else return null;
  }
  return null;
}

const UPLOAD_V0_CAPS =
  'symref=HEAD:refs/heads/main multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done filter object-format=sha1 agent=' + AGENT;

const RECEIVE_V0_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

/** v0 advertisement for `service` (git-upload-pack | git-receive-pack). */
export function advertisementV0(repo: Repo, service: string): Buffer {
  const caps = service === 'git-receive-pack' ? RECEIVE_V0_CAPS : UPLOAD_V0_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const headTip = repo.refs.get('refs/heads/main') ?? ZERO_OID;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headTip} HEAD\0${caps}\n`));
    for (const r of refs) {
      parts.push(pktLine(`${r.oid} ${r.name}\n`));
      const peeled = peeledCommit(repo, r.oid);
      if (peeled) parts.push(pktLine(`${peeled} ${r.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** v2 advertisement (upload-pack only). */
export function advertisementV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('server-option\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

// ---------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------

export function handleLsRefsV2(repo: Repo, packets: PktPacket[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let afterDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) continue; // command= / agent= / object-format=
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const headTip = repo.refs.get('refs/heads/main');
  const headRef = 'refs/heads/main';
  if (keep('HEAD')) {
    if (headTip) {
      out.push(
        pktLine(
          symrefs
            ? `${headTip} HEAD symref-target:${headRef}\n`
            : `${headTip} HEAD\n`,
        ),
      );
    } else if (unborn) {
      out.push(
        pktLine(
          symrefs
            ? `unborn HEAD symref-target:${headRef}\n`
            : `unborn HEAD\n`,
        ),
      );
    }
  }
  for (const r of sortedRefs(repo)) {
    if (!keep(r.name)) continue;
    let line = `${r.oid} ${r.name}`;
    if (peel) {
      const peeled = peeledCommit(repo, r.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    out.push(pktLine(`${line}\n`));
  }
  out.push(pktFlush());
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
  ready: boolean;
}

function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | null,
  clientShallow: string[],
): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const shallowSet = new Set(clientShallow);

  // Held = full closure of the haves — except that a client-shallow
  // boundary stops the walk: the client has that commit and its tree,
  // but not its parents (that is what "shallow" means).
  const held = new Set<string>();
  const collect = (roots: string[]): void => {
    const stack = [...roots];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (held.has(oid)) continue;
      const obj = lookup(oid);
      if (!obj) continue;
      held.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        stack.push(c.tree);
        if (!shallowSet.has(oid)) {
          for (const p of c.parents) stack.push(p);
        }
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      }
    }
  };
  collect(haves);

  const depthLimit = depth === null ? Infinity : depth;
  const send = new Set<string>();
  const shallow = new Set<string>();
  const unshallow = new Set<string>();
  const queue: { oid: string; dist: number }[] = [];
  const visited = new Set<string>();
  for (const w of wants) queue.push({ oid: w, dist: 0 });

  while (queue.length > 0) {
    const { oid, dist } = queue.shift() as { oid: string; dist: number };
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = lookup(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      if (!held.has(oid)) send.add(oid);
      queue.push({ oid: parseTag(obj.data).object, dist });
      continue;
    }
    if (obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    if (!held.has(oid)) {
      send.add(oid);
      // The commit's tree closure (excluding held objects).
      const treeStack = [c.tree];
      const treeSeen = new Set<string>();
      while (treeStack.length > 0) {
        const t = treeStack.pop() as string;
        if (treeSeen.has(t) || held.has(t)) continue;
        treeSeen.add(t);
        const tobj = lookup(t);
        if (!tobj) continue;
        send.add(t);
        if (tobj.type === 'tree') {
          for (const e of parseTree(tobj.data)) treeStack.push(e.oid);
        }
      }
    }
    if (depthLimit !== Infinity && dist === depthLimit - 1) shallow.add(oid);
    if (shallowSet.has(oid) && dist < depthLimit - 1) unshallow.add(oid);
    if (dist < depthLimit - 1) {
      for (const p of c.parents) queue.push({ oid: p, dist: dist + 1 });
    }
  }

  // Acks: haves that are a want or an ancestor of a want.
  const acks: string[] = [];
  const isAncestor = (ancestor: string, oid: string): boolean => {
    if (ancestor === oid) return true;
    const seen = new Set<string>();
    const stack = [oid];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = lookup(cur);
      if (!obj) continue;
      if (obj.type === 'commit') {
        for (const p of parseCommit(obj.data).parents) {
          if (p === ancestor) return true;
          stack.push(p);
        }
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
    return false;
  };
  for (const h of haves) {
    if (wants.some((w) => isAncestor(h, w))) acks.push(h);
  }
  const nak = haves.length === 0 || acks.length === 0;
  const ready = acks.length > 0;

  const objects: GitObject[] = [];
  for (const oid of send) {
    const obj = lookup(oid);
    if (obj) objects.push(obj);
  }
  return {
    objects,
    shallow: [...shallow],
    unshallow: [...unshallow],
    acks,
    nak,
    ready,
  };
}

/** Sideband-framed pack bytes (band 1), split into ≤32 KiB chunks. */
function sidebandPack(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  for (let off = 0; off < pack.length; off += 32768) {
    const slice = pack.subarray(off, off + 32768);
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// v2 fetch
// ---------------------------------------------------------------------------

export function handleFetchV2(repo: Repo, packets: PktPacket[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let afterDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) continue;
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7).trim(), 10);
  }
  const plan = planFetch(repo, wants, haves, depth, shallow);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (plan.nak) parts.push(pktLine('NAK\n'));
  for (const a of plan.acks) parts.push(pktLine(`ACK ${a}\n`));
  if (plan.ready) parts.push(pktLine('ready\n'));
  parts.push(pktDelim());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const u of plan.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(pktDelim());
  }
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPack(pack));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// v0 fetch (fallback; the suite uses v2 when advertised). A v0 fetch is two
// sections: wants (+ shallow/deepen) terminated by a flush, then the
// negotiation (have lines and done) terminated by a second flush.
// ---------------------------------------------------------------------------

export function handleFetchV0(repo: Repo, packets: PktPacket[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    const firstSpace = line.indexOf(' ');
    const cmd = firstSpace === -1 ? line : line.slice(0, firstSpace);
    const rest = firstSpace === -1 ? '' : line.slice(firstSpace + 1);
    if (cmd === 'want') wants.push(rest.split(' ')[0]);
    else if (cmd === 'have') haves.push(rest);
    else if (cmd === 'shallow') shallow.push(rest);
    else if (cmd === 'deepen') depth = parseInt(rest, 10);
  }
  const plan = planFetch(repo, wants, haves, depth, shallow);
  const parts: Buffer[] = [];
  if (plan.nak) parts.push(pktLine('NAK\n'));
  for (const a of plan.acks) parts.push(pktLine(`ACK ${a}\n`));
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const u of plan.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  if (plan.objects.length > 0) {
    parts.push(...sidebandPack(writePack(plan.objects)));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface RefUpdate {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(repo: Repo, body: Buffer): GitReply {
  const { packets, restOffset } = decodePktLines(body);
  const updates: RefUpdate[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    let line = p.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) line = line.slice(0, nul); // capabilities on the first line
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    updates.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  const packBytes = body.subarray(restOffset);
  let unpackOk = true;
  let unpackDetail = '';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes);
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (e) {
      unpackOk = false;
      unpackDetail = e instanceof Error ? e.message : String(e);
    }
  }
  const lines: string[] = [];
  if (unpackOk) lines.push('unpack ok');
  else lines.push(`unpack ${unpackDetail}`);
  for (const u of updates) {
    const current = repo.refs.get(u.ref) ?? null;
    if (!unpackOk) {
      lines.push(`ng ${u.ref} unpack failed`);
      continue;
    }
    if (u.newOid === ZERO_OID) {
      // Delete.
      if (current === null) {
        lines.push(`ng ${u.ref} no such ref`);
      } else if (u.oldOid !== ZERO_OID && u.oldOid !== current) {
        lines.push(`ng ${u.ref} non-fast-forward`);
      } else {
        repo.refs.delete(u.ref);
        lines.push(`ok ${u.ref}`);
      }
      continue;
    }
    const newObj = repo.objects.get(u.newOid);
    if (!newObj || (newObj.type !== 'commit' && newObj.type !== 'tag')) {
      lines.push(`ng ${u.ref} object not found`);
      continue;
    }
    if (current === null) {
      // Create.
      if (u.oldOid !== ZERO_OID) {
        lines.push(`ng ${u.ref} non-fast-forward`);
      } else {
        repo.refs.set(u.ref, u.newOid);
        lines.push(`ok ${u.ref}`);
      }
      continue;
    }
    // Update.
    if (u.oldOid !== current) {
      lines.push(`ng ${u.ref} non-fast-forward`);
      continue;
    }
    if (!isAncestorOf(repo, current, u.newOid)) {
      lines.push(`ng ${u.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(u.ref, u.newOid);
    lines.push(`ok ${u.ref}`);
  }
  const report = lines.map((l) => `${l}\n`).join('');
  const bodyOut = Buffer.concat([
    pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(report, 'utf8')])),
    pktFlush(),
  ]);
  return gitReply(200, bodyOut, 'application/x-git-receive-pack-result');
}

function isAncestorOf(repo: Repo, ancestor: string, oid: string): boolean {
  if (ancestor === oid) return true;
  const seen = new Set<string>();
  const stack = [oid];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj) continue;
    if (obj.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) {
        if (p === ancestor) return true;
        stack.push(p);
      }
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// entry points used by app.ts
// ---------------------------------------------------------------------------

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(repo: Repo | null, service: string, gitProtocolHeader: string): GitReply {
  if (!repo) {
    return gitReply(404, Buffer.from('repository not found\n', 'utf8'), 'text/plain; charset=utf-8');
  }
  // The Git-Protocol header value is `version=2`, not `2`.
  if (gitProtocolHeader.includes('version=2') && service === 'git-upload-pack') {
    return gitReply(200, advertisementV2(), 'application/x-git-upload-pack-advertisement');
  }
  const body = advertisementV0(repo, service);
  const ct =
    service === 'git-receive-pack'
      ? 'application/x-git-receive-pack-advertisement'
      : 'application/x-git-upload-pack-advertisement';
  return gitReply(200, body, ct);
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(repo: Repo | null, body: Buffer, gitProtocolHeader: string): GitReply {
  if (!repo) {
    return gitReply(404, Buffer.from('repository not found\n', 'utf8'), 'text/plain; charset=utf-8');
  }
  // The Git-Protocol header value is `version=2`, not `2`.
  if (gitProtocolHeader.includes('version=2')) {
    const packets = decodeAllPktLines(body);
    const first = packets.find((p) => p.kind === 'data');
    const command = first ? first.payload.toString('utf8').replace(/\n$/, '') : '';
    if (command === 'command=ls-refs') {
      return gitReply(200, handleLsRefsV2(repo, packets), 'application/x-git-upload-pack-result');
    }
    if (command === 'command=fetch') {
      return gitReply(200, handleFetchV2(repo, packets), 'application/x-git-upload-pack-result');
    }
    return gitReply(400, Buffer.from('unknown v2 command\n', 'utf8'), 'text/plain; charset=utf-8');
  }
  const packets = decodeAllPktLines(body);
  return gitReply(200, handleFetchV0(repo, packets), 'application/x-git-upload-pack-result');
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePackEndpoint(repo: Repo | null, body: Buffer): GitReply {
  if (!repo) {
    return gitReply(404, Buffer.from('repository not found\n', 'utf8'), 'text/plain; charset=utf-8');
  }
  return handleReceivePack(repo, body);
}

export { hashObject };
