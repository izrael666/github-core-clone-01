// store.ts — the in-memory forge store.
//
// Everything the harness can create or observe lives here: repositories,
// git objects and refs, issues, pull requests, labels and comments. The
// store is the single source of truth shared by REST, GraphQL, MCP and
// the git smart-HTTP handlers, so a repository created through one
// surface is visible through all of them.

import {
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
} from './gitcore.ts';
import type { GitObject, GitObjectType } from './gitcore.ts';
import { SCENARIO_EPOCH_SEC, VIEWER } from './scenario.ts';

export interface UserRef {
  login: string;
  id: number;
  name: string;
  email: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextIssueNumber: number;
  nextPullNumber: number;
}

export class StoreError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join('|'), 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const raw = Buffer.from(id, 'base64').toString('utf8');
    const parts = raw.split('|');
    if (parts.length < 2) return null;
    return { kind: parts[0], parts: parts.slice(1) };
  } catch {
    return null;
  }
}

/** Deterministic, monotonically increasing ISO clock (base = scenario epoch). */
let clockSeq = 0;
export function nowIso(): string {
  clockSeq += 1;
  return new Date((SCENARIO_EPOCH_SEC + clockSeq) * 1000).toISOString();
}

/** Timestamp counter for git commits created through REST (seconds). */
let commitSeq = 0;
export function nextCommitTimestamp(): number {
  commitSeq += 1;
  return SCENARIO_EPOCH_SEC + commitSeq;
}

export const VIEWER_IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextIssueId = 1;
  nextCommentId = 1;
  nextPullId = 1;
  nextLabelId = 1;
  repoSeq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  // -------------------------------------------------------------------------
  // repositories
  // -------------------------------------------------------------------------

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const owner = VIEWER.login;
    const k = this.key(owner, name);
    if (this.repos.has(k)) throw new StoreError(422, `Repository ${name} already exists`);
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      seq: ++this.repoSeq,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
    };
    this.repos.set(k, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(this.key(owner, name)) ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  // -------------------------------------------------------------------------
  // git objects / refs
  // -------------------------------------------------------------------------

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  putObjects(repo: Repo, objects: Map<string, GitObject>): void {
    for (const [oid, obj] of objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  }

  resolveRef(repo: Repo, ref: string): string | null {
    const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    return repo.refs.get(full) ?? null;
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    repo.refs.set(full, oid);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    return repo.refs.delete(full);
  }

  isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
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
        const c = parseCommit(obj.data);
        for (const p of c.parents) {
          if (p === ancestor) return true;
          stack.push(p);
        }
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
    return false;
  }

  /** Build a tree object from a flat path map, storing every intermediate
   * tree. `baseTreeOid` may be null for an empty tree. */
  treeFromMap(repo: Repo, flat: Map<string, { mode: string; oid: string }>): string {
    interface Node {
      entries: Map<string, { mode: string; oid: string } | Node>;
    }
    const root: Node = { entries: new Map() };
    for (const [path, entry] of flat) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        let child = node.entries.get(part);
        if (!child || !('entries' in (child as Node))) {
          child = { entries: new Map() };
          node.entries.set(part, child as Node);
        }
        node = child as Node;
      }
      node.entries.set(parts[parts.length - 1], entry);
    }
    const build = (node: Node): string => {
      const entries: { mode: string; name: string; oid: string }[] = [];
      for (const [name, child] of node.entries) {
        if ('entries' in (child as Node)) {
          entries.push({ mode: '40000', name, oid: build(child as Node) });
        } else {
          const e = child as { mode: string; oid: string };
          entries.push({ mode: e.mode, name, oid: e.oid });
        }
      }
      const data = buildTree(entries);
      return this.putObject(repo, 'tree', data);
    };
    return build(root);
  }

  /** Flatten a tree object into a path map. */
  mapFromTree(repo: Repo, treeOid: string | null): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    if (!treeOid || treeOid === ZERO_OID) return out;
    const walk = (oid: string, prefix: string): void => {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'tree') return;
      for (const e of parseTree(obj.data)) {
        const path = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.mode === '40000') walk(e.oid, path);
        else out.set(path, { mode: e.mode, oid: e.oid });
      }
    };
    walk(treeOid, '');
    return out;
  }

  commitTreeOf(repo: Repo, commitOid: string): string | null {
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return null;
    return parseCommit(obj.data).tree;
  }

  /** Create a commit object (author/committer = viewer identity) and store it. */
  createCommit(
    repo: Repo,
    tree: string,
    parents: string[],
    message: string,
    timestamp?: number,
  ): string {
    const data = buildCommit({
      tree,
      parents,
      message,
      author: VIEWER_IDENTITY,
      committer: VIEWER_IDENTITY,
      timestamp: timestamp ?? nextCommitTimestamp(),
    });
    return this.putObject(repo, 'commit', data);
  }

  /** List commits reachable from a ref (newest first). */
  listCommits(repo: Repo, refName?: string): { sha: string; message: string; author: string; committer: string; parents: string[]; tree: string }[] {
    const tip = refName ? this.resolveRef(repo, refName) : this.resolveRef(repo, repo.defaultBranch);
    if (!tip) return [];
    const out: { sha: string; message: string; author: string; committer: string; parents: string[]; tree: string }[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
        continue;
      }
      if (obj.type !== 'commit') continue;
      const c = parseCommit(obj.data);
      out.push({ sha: oid, message: c.message, author: c.author, committer: c.committer, parents: c.parents, tree: c.tree });
      for (const p of c.parents) stack.push(p);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // diff / merge
  // -------------------------------------------------------------------------

  diffMaps(
    base: Map<string, { mode: string; oid: string }>,
    head: Map<string, { mode: string; oid: string }>,
  ): { filename: string; status: 'added' | 'modified' | 'removed'; oid: string | null; baseOid: string | null }[] {
    const out: { filename: string; status: 'added' | 'modified' | 'removed'; oid: string | null; baseOid: string | null }[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const p of [...paths].sort()) {
      const b = base.get(p);
      const h = head.get(p);
      if (b && !h) out.push({ filename: p, status: 'removed', oid: null, baseOid: b.oid });
      else if (!b && h) out.push({ filename: p, status: 'added', oid: h.oid, baseOid: null });
      else if (b && h && (b.oid !== h.oid || b.mode !== h.mode)) {
        out.push({ filename: p, status: 'modified', oid: h.oid, baseOid: b.oid });
      }
    }
    return out;
  }

  /** Line counts for a file change (prefix/suffix aware, good enough for
   * the harness which only requires the numbers to exist). */
  lineCounts(repo: Repo, baseOid: string | null, headOid: string | null): { additions: number; deletions: number } {
    const read = (oid: string | null): string[] => {
      if (!oid) return [];
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'blob') return [];
      const text = obj.data.toString('utf8');
      if (text === '') return [];
      return text.split('\n');
    };
    const a = read(baseOid);
    const b = read(headOid);
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
    let suffix = 0;
    while (
      suffix < a.length - prefix &&
      suffix < b.length - prefix &&
      a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
    ) {
      suffix++;
    }
    return { additions: b.length - prefix - suffix, deletions: a.length - prefix - suffix };
  }

  /** Conflict rule: a path changed head-vs-base is also changed on the
   * current base tip vs the PR's base, to a different blob. */
  prMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
    const baseTip = this.resolveRef(repo, pull.baseRef);
    if (!baseTip) return 'CONFLICTING';
    if (baseTip === pull.baseSha) return 'MERGEABLE';
    const baseTree = this.commitTreeOf(repo, pull.baseSha);
    const headTree = this.commitTreeOf(repo, pull.headSha);
    const tipTree = this.commitTreeOf(repo, baseTip);
    if (baseTree === null || headTree === null || tipTree === null) return 'CONFLICTING';
    const baseMap = this.mapFromTree(repo, baseTree);
    const headMap = this.mapFromTree(repo, headTree);
    const tipMap = this.mapFromTree(repo, tipTree);
    for (const { filename } of this.diffMaps(baseMap, headMap)) {
      const b = baseMap.get(filename)?.oid ?? null;
      const h = headMap.get(filename)?.oid ?? null;
      const t = tipMap.get(filename)?.oid ?? null;
      if (t !== b && t !== h) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  /** Squash-merge a pull request onto its base branch. */
  mergePull(repo: Repo, pull: Pull): { sha: string; message: string } {
    if (pull.state !== 'open' || pull.merged) {
      throw new StoreError(405, `Pull request #${pull.number} is already merged or closed`);
    }
    const baseTip = this.resolveRef(repo, pull.baseRef);
    if (!baseTip) throw new StoreError(404, `Base branch ${pull.baseRef} not found`);
    const headObj = repo.objects.get(pull.headSha);
    if (!headObj) throw new StoreError(404, `Head commit ${pull.headSha} not found`);
    if (this.prMergeable(repo, pull) === 'CONFLICTING') {
      throw new StoreError(405, `Pull request #${pull.number} has conflicts`);
    }
    const baseTree = this.commitTreeOf(repo, pull.baseSha);
    const headTree = this.commitTreeOf(repo, pull.headSha);
    const tipTree = this.commitTreeOf(repo, baseTip);
    if (baseTree === null || headTree === null || tipTree === null) {
      throw new StoreError(405, `Pull request #${pull.number} has conflicts`);
    }
    const baseMap = this.mapFromTree(repo, baseTree);
    const headMap = this.mapFromTree(repo, headTree);
    const tipMap = this.mapFromTree(repo, tipTree);
    // Apply the head's changes onto the current base tip.
    for (const { filename } of this.diffMaps(baseMap, headMap)) {
      const h = headMap.get(filename);
      if (h) tipMap.set(filename, h);
      else tipMap.delete(filename);
    }
    const mergedTree = this.treeFromMap(repo, tipMap);
    const message = `${pull.title}\n\n${pull.body ?? ''}`.trim();
    const mergeSha = this.createCommit(repo, mergedTree, [baseTip], message);
    this.setRef(repo, pull.baseRef, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = nowIso();
    pull.mergeCommitSha = mergeSha;
    pull.updatedAt = nowIso();
    return { sha: mergeSha, message };
  }

  prFiles(repo: Repo, pull: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number; sha: string | null }[] {
    const baseTree = this.commitTreeOf(repo, pull.baseSha);
    const headTree = this.commitTreeOf(repo, pull.headSha);
    if (baseTree === null || headTree === null) return [];
    const baseMap = this.mapFromTree(repo, baseTree);
    const headMap = this.mapFromTree(repo, headTree);
    return this.diffMaps(baseMap, headMap).map((d) => {
      const counts = this.lineCounts(repo, d.baseOid, d.oid);
      return {
        filename: d.filename,
        status: d.status,
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
        sha: d.oid,
      };
    });
  }

  // -------------------------------------------------------------------------
  // labels / issues / comments
  // -------------------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string): Label {
    if (repo.labels.has(name)) throw new StoreError(422, `Label ${name} already exists`);
    const label: Label = { id: this.nextLabelId++, name, color: color || 'ededed' };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (!label) throw new StoreError(422, `Label ${name} does not exist`);
      labels.push(label);
    }
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextIssueNumber++,
      title,
      body,
      state: 'open',
      labels,
      comments: [],
      seq: this.nextIssueId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    repo.issues.push(issue);
    return issue;
  }

  listIssues(
    repo: Repo,
    opts: { state?: string; sort?: string; direction?: string },
  ): Issue[] {
    let list = [...repo.issues];
    const state = opts.state ?? 'open';
    if (state !== 'all') list = list.filter((i) => i.state === state);
    const dir = (opts.direction ?? 'asc') === 'desc' ? -1 : 1;
    // `created` is insertion order (seq).
    list.sort((a, b) => (a.seq - b.seq) * dir);
    return list;
  }

  getIssue(repo: Repo, number: number): Issue | null {
    return repo.issues.find((i) => i.number === number) ?? null;
  }

  addComment(repo: Repo, issueNumber: number, body: string): Comment {
    const issue = this.getIssue(repo, issueNumber);
    if (!issue) throw new StoreError(404, `Issue #${issueNumber} not found`);
    const comment: Comment = { id: this.nextCommentId++, body, createdAt: nowIso(), updatedAt: nowIso() };
    issue.comments.push(comment);
    return comment;
  }

  // -------------------------------------------------------------------------
  // pull requests
  // -------------------------------------------------------------------------

  createPull(
    repo: Repo,
    head: string,
    base: string,
    title: string,
    body: string,
  ): Pull {
    const headSha = this.resolveRef(repo, head);
    const baseSha = this.resolveRef(repo, base);
    if (!headSha) throw new StoreError(422, `Head branch ${head} not found`);
    if (!baseSha) throw new StoreError(422, `Base branch ${base} not found`);
    for (const p of repo.pulls) {
      if (p.headRef === head && p.state === 'open') {
        throw new StoreError(422, `An open pull request already exists for ${head}`);
      }
    }
    const pull: Pull = {
      id: this.nextPullId++,
      number: repo.nextPullNumber++,
      title,
      body,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: this.nextPullId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    repo.pulls.push(pull);
    return pull;
  }

  listPulls(repo: Repo, state?: string): Pull[] {
    const s = state ?? 'open';
    if (s === 'all') return [...repo.pulls];
    if (s === 'closed') return repo.pulls.filter((p) => p.state === 'closed');
    return repo.pulls.filter((p) => p.state === 'open');
  }

  getPull(repo: Repo, number: number): Pull | null {
    return repo.pulls.find((p) => p.number === number) ?? null;
  }

  // -------------------------------------------------------------------------
  // contents API (files as git commits)
  // -------------------------------------------------------------------------

  /** Create or update a file on a branch. Returns the blob sha, commit sha
   * and whether it was a creation (201) or an update (200). */
  putContent(
    repo: Repo,
    path: string,
    contentB64: string,
    message: string,
    branch?: string,
    expectedSha?: string,
  ): { blobSha: string; commitSha: string; created: boolean } {
    const branchName = branch ?? repo.defaultBranch;
    const tip = this.resolveRef(repo, branchName);
    const baseTree = tip ? this.commitTreeOf(repo, tip) : null;
    const flat = this.mapFromTree(repo, baseTree);
    const existing = flat.get(path);
    const created = !existing;
    if (expectedSha && existing && existing.oid !== expectedSha) {
      throw new StoreError(409, `sha ${expectedSha} does not match the current blob`);
    }
    if (expectedSha && !existing) {
      throw new StoreError(409, `sha ${expectedSha} does not match the current blob`);
    }
    const clean = contentB64.replace(/\s+/g, '');
    const blobSha = this.putObject(repo, 'blob', Buffer.from(clean, 'base64'));
    flat.set(path, { mode: '100644', oid: blobSha });
    const tree = this.treeFromMap(repo, flat);
    const commitSha = this.createCommit(repo, tree, tip ? [tip] : [], message);
    // If the branch did not exist, the commit creates it; otherwise move it.
    this.setRef(repo, branchName, commitSha);
    return { blobSha, commitSha, created };
  }

  getContent(
    repo: Repo,
    path: string,
    ref?: string,
  ): { type: 'file'; blobSha: string; size: number; contentB64: string } | { type: 'dir'; entries: { type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }[] } | null {
    const tip = ref ? this.resolveRef(repo, ref) : this.resolveRef(repo, repo.defaultBranch);
    if (!tip) return null;
    const tree = this.commitTreeOf(repo, tip);
    if (tree === null) return null;
    const flat = this.mapFromTree(repo, tree);
    const direct = flat.get(path);
    if (direct) {
      const obj = repo.objects.get(direct.oid);
      if (!obj || obj.type !== 'blob') return null;
      return { type: 'file', blobSha: direct.oid, size: obj.data.length, contentB64: obj.data.toString('base64') };
    }
    // Directory listing: entries directly under `path/`.
    const prefix = path === '' ? '' : `${path}/`;
    const seen = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }>();
    for (const [p, entry] of flat) {
      if (prefix && !p.startsWith(prefix)) continue;
      const rest = prefix ? p.slice(prefix.length) : p;
      const first = rest.split('/')[0];
      if (rest.includes('/')) {
        if (!seen.has(first)) {
          seen.set(first, { type: 'dir', name: first, path: prefix + first, sha: '', size: 0 });
        }
      } else {
        const obj = repo.objects.get(entry.oid);
        seen.set(first, { type: 'file', name: first, path: p, sha: entry.oid, size: obj?.data.length ?? 0 });
      }
    }
    if (seen.size === 0) return null;
    return { type: 'dir', entries: [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : 1)) };
  }

  deleteContent(repo: Repo, path: string, message: string, branch?: string, expectedSha?: string): { commitSha: string } {
    const branchName = branch ?? repo.defaultBranch;
    const tip = this.resolveRef(repo, branchName);
    if (!tip) throw new StoreError(404, `Branch ${branchName} not found`);
    const tree = this.commitTreeOf(repo, tip);
    if (tree === null) throw new StoreError(404, `File ${path} not found`);
    const flat = this.mapFromTree(repo, tree);
    const existing = flat.get(path);
    if (!existing) throw new StoreError(404, `File ${path} not found`);
    if (expectedSha && existing.oid !== expectedSha) {
      throw new StoreError(409, `sha ${expectedSha} does not match the current blob`);
    }
    flat.delete(path);
    const newTree = this.treeFromMap(repo, flat);
    const commitSha = this.createCommit(repo, newTree, [tip], message);
    this.setRef(repo, branchName, commitSha);
    return { commitSha };
  }

}
