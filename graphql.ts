// graphql.ts — a mini GraphQL v4 parser + executor.
//
// The harness sends a fixed set of 18 documents (gh's real queries and
// mutations): viewer/repository reads, __type introspection probes,
// issue and pull-request reads with cursor pagination, and the five
// mutations. This module implements exactly the surface those documents
// need: operation names, variables, aliases, inline fragments,
// inline enum lists, inline input objects, null variables and batched
// requests. Unknown fields are a 200 with an errors array (never a 400).

import { decodeGlobalId, globalId, nowIso, StoreError, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { VIEWER } from './scenario.ts';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';
interface Token {
  kind: TokenKind;
  value: string;
}

function lex(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '\\') out += '\\';
          else if (esc === '"') out += '"';
          else if (esc === '/') out += '/';
          else out += esc;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (src[j] === '-') j++;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      let isFloat = false;
      if (src[j] === '.') {
        isFloat = true;
        j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Map<string, ValueNode> };

type Selection =
  | { kind: 'field'; alias: string | null; name: string; args: Map<string, ValueNode>; selections: Selection[] }
  | { kind: 'fragment'; typeCondition: string | null; selections: Selection[] };

interface Operation {
  operation: 'query' | 'mutation';
  name: string | null;
  varDefs: Map<string, { default?: ValueNode }>;
  selections: Selection[];
}

class Parser {
  private tokens: Token[];
  private pos = 0;
  constructor(src: string) {
    this.tokens = lex(src);
  }
  private peek(): Token {
    return this.tokens[this.pos];
  }
  private next(): Token {
    return this.tokens[this.pos++];
  }
  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) {
      throw new Error(`expected ${value}, got ${t.value || t.kind}`);
    }
  }
  private expectName(value?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected a name, got ${t.value || t.kind}`);
    if (value !== undefined && t.value !== value) throw new Error(`expected ${value}, got ${t.value}`);
    return t.value;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): Operation {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const t = this.peek();
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
      if (this.peek().kind === 'name') name = this.next().value;
    }
    const varDefs = this.parseVariableDefinitions();
    const selections = this.parseSelectionSet();
    return { operation, name, varDefs, selections };
  }

  private parseVariableDefinitions(): Map<string, { default?: ValueNode }> {
    const defs = new Map<string, { default?: ValueNode }>();
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let def: { default?: ValueNode } = {};
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          def = { default: this.parseValue() };
        }
        defs.set(name, def);
      }
      this.expectPunct(')');
    }
    return defs;
  }

  /** Parse a type reference (named, list, non-null) and discard it. */
  private parseType(): void {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const sels: Selection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      sels.push(this.parseSelection());
    }
    this.expectPunct('}');
    return sels;
  }

  private parseSelection(): Selection {
    const t = this.peek();
    if (t.kind === 'spread') {
      this.next();
      let typeCondition: string | null = null;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      const selections = this.parseSelectionSet();
      return { kind: 'fragment', typeCondition, selections };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    let selections: Selection[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Map<string, ValueNode> {
    const args = new Map<string, ValueNode>();
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const name = this.expectName();
        this.expectPunct(':');
        args.set(name, this.parseValue());
      }
      this.expectPunct(')');
    }
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields = new Map<string, ValueNode>();
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.set(name, this.parseValue());
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected token ${t.value || t.kind} in value`);
  }
}

// ---------------------------------------------------------------------------
// Schema (the surface the harness's documents need)
// ---------------------------------------------------------------------------

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'INTERFACE';
  fields?: Set<string>;
  values?: string[];
}

const SCHEMA: Record<string, TypeDef> = {
  Query: { kind: 'OBJECT', fields: new Set(['viewer', 'repository', 'node', '__type', '__typename']) },
  Mutation: { kind: 'OBJECT', fields: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', '__typename']) },
  Node: { kind: 'INTERFACE', fields: new Set(['id', '__typename']) },
  User: { kind: 'OBJECT', fields: new Set(['id', 'login', 'name', 'email', '__typename']) },
  Repository: {
    kind: 'OBJECT',
    fields: new Set(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt', 'updatedAt', '__typename']),
  },
  Issue: { kind: 'OBJECT', fields: new Set(['id', 'databaseId', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', '__typename']) },
  IssueConnection: { kind: 'OBJECT', fields: new Set(['nodes', 'edges', 'pageInfo', 'totalCount', '__typename']) },
  IssueEdge: { kind: 'OBJECT', fields: new Set(['node', 'cursor', '__typename']) },
  PageInfo: { kind: 'OBJECT', fields: new Set(['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor', '__typename']) },
  PullRequest: {
    kind: 'OBJECT',
    fields: new Set(['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeCommit', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'files', 'url', 'createdAt', 'updatedAt', 'author', '__typename']),
  },
  PullRequestConnection: { kind: 'OBJECT', fields: new Set(['nodes', 'edges', 'pageInfo', 'totalCount', '__typename']) },
  PullRequestChangedFile: { kind: 'OBJECT', fields: new Set(['path', 'additions', 'deletions', 'changeType', '__typename']) },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: new Set(['nodes', 'edges', 'pageInfo', 'totalCount', '__typename']) },
  Ref: { kind: 'OBJECT', fields: new Set(['name', '__typename']) },
  Label: { kind: 'OBJECT', fields: new Set(['id', 'name', 'color', 'description', '__typename']) },
  LabelConnection: { kind: 'OBJECT', fields: new Set(['nodes', 'totalCount', '__typename']) },
  IssueComment: { kind: 'OBJECT', fields: new Set(['id', 'body', 'createdAt', 'updatedAt', 'author', '__typename']) },
  IssueCommentConnection: { kind: 'OBJECT', fields: new Set(['nodes', 'totalCount', '__typename']) },
  IssueCommentEdge: { kind: 'OBJECT', fields: new Set(['node', 'cursor', '__typename']) },
  CreateIssuePayload: { kind: 'OBJECT', fields: new Set(['issue', '__typename']) },
  CloseIssuePayload: { kind: 'OBJECT', fields: new Set(['issue', '__typename']) },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: new Set(['pullRequest', '__typename']) },
  MergePullRequestPayload: { kind: 'OBJECT', fields: new Set(['pullRequest', '__typename']) },
  AddCommentPayload: { kind: 'OBJECT', fields: new Set(['commentEdge', '__typename']) },
  SearchType: { kind: 'ENUM', values: ['ISSUE', 'REPOSITORY', 'USER'] },
  IssueState: { kind: 'ENUM', values: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', values: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', values: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', values: ['ASC', 'DESC'] },
  __Type: { kind: 'OBJECT', fields: new Set(['name', 'kind', 'description', 'fields', 'enumValues', '__typename']) },
  __Field: { kind: 'OBJECT', fields: new Set(['name', 'description', 'args', 'type', '__typename']) },
  __EnumValue: { kind: 'OBJECT', fields: new Set(['name', 'description', '__typename']) },
  __InputValue: { kind: 'OBJECT', fields: new Set(['name', 'description', 'type', 'defaultValue', '__typename']) },
  Commit: { kind: 'OBJECT', fields: new Set(['oid', '__typename']) },
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

class GraphQLError extends Error {}

type Tagged = { __type: string; [key: string]: unknown };

interface ExecContext {
  store: Store;
  errors: { message: string }[];
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of node.fields) out[k] = resolveValue(v, variables);
      return out;
    }
  }
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(raw);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

function pageInfoFor(items: { number: number }[], total: number, hasNext: boolean): Tagged {
  const end = items.length > 0 ? cursorFor(items[items.length - 1].number) : null;
  const start = items.length > 0 ? cursorFor(items[0].number) : null;
  return {
    __type: 'PageInfo',
    hasNextPage: hasNext,
    hasPreviousPage: false,
    startCursor: start,
    endCursor: end,
    total,
  };
}

function issueTag(repo: Repo, issue: Issue): Tagged {
  return { __type: 'Issue', repo, issue };
}

function pullTag(repo: Repo, pull: Pull): Tagged {
  return { __type: 'PullRequest', repo, pull };
}

function repoTag(repo: Repo): Tagged {
  return { __type: 'Repository', repo };
}

function userTag(): Tagged {
  return { __type: 'User', user: VIEWER };
}

function decodeNodeId(store: Store, id: string): Tagged | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  const [kind] = [decoded.kind];
  const parts = decoded.parts;
  if (kind === 'Repository' && parts.length === 2) {
    const repo = store.getRepo(parts[0], parts[1]);
    return repo ? repoTag(repo) : null;
  }
  if (kind === 'Issue' && parts.length === 3) {
    const repo = store.getRepo(parts[0], parts[1]);
    const issue = repo ? store.getIssue(repo, parseInt(parts[2], 10)) : null;
    return repo && issue ? issueTag(repo, issue) : null;
  }
  if (kind === 'PullRequest' && parts.length === 3) {
    const repo = store.getRepo(parts[0], parts[1]);
    const pull = repo ? store.getPull(repo, parseInt(parts[2], 10)) : null;
    return repo && pull ? pullTag(repo, pull) : null;
  }
  if (kind === 'IssueComment' && parts.length === 4) {
    const repo = store.getRepo(parts[0], parts[1]);
    const issue = repo ? store.getIssue(repo, parseInt(parts[2], 10)) : null;
    const comment = issue?.comments.find((c) => c.id === parseInt(parts[3], 10));
    return repo && issue && comment
      ? { __type: 'IssueComment', repo, issue, comment }
      : null;
  }
  return null;
}

function resolveQuery(ctx: ExecContext, field: string, args: Record<string, unknown>): unknown {
  if (field === 'viewer') return userTag();
  if (field === 'repository') {
    const repo = ctx.store.getRepo(String(args.owner), String(args.name));
    return repo ? repoTag(repo) : null;
  }
  if (field === 'node') {
    return decodeNodeId(ctx.store, String(args.id));
  }
  if (field === '__type') {
    const def = SCHEMA[String(args.name)];
    if (!def) return null;
    return {
      __type: '__Type',
      name: String(args.name),
      kind: def.kind,
      description: null,
      fields: def.fields ? [...def.fields].filter((f) => f !== '__typename').map((f) => ({ __type: '__Field', name: f, description: null, args: [], type: null })) : null,
      enumValues: def.values ? def.values.map((v) => ({ __type: '__EnumValue', name: v, description: null })) : null,
    };
  }
  throw new GraphQLError(`Cannot query field "${field}" on type "Query".`);
}

function resolveMutation(ctx: ExecContext, field: string, args: Record<string, unknown>): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (field === 'createIssue') {
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    if (!decoded || decoded.kind !== 'Repository') throw new GraphQLError('createIssue: repositoryId is not a Repository id');
    const repo = ctx.store.getRepo(decoded.parts[0], decoded.parts[1]);
    if (!repo) throw new GraphQLError('createIssue: repository not found');
    const issue = ctx.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
    return { __type: 'CreateIssuePayload', issue: issueTag(repo, issue) };
  }
  if (field === 'closeIssue') {
    const decoded = decodeGlobalId(String(input.issueId ?? ''));
    if (!decoded || decoded.kind !== 'Issue') throw new GraphQLError('closeIssue: issueId is not an Issue id');
    const repo = ctx.store.getRepo(decoded.parts[0], decoded.parts[1]);
    const issue = repo ? ctx.store.getIssue(repo, parseInt(decoded.parts[2], 10)) : null;
    if (!repo || !issue) throw new GraphQLError('closeIssue: issue not found');
    issue.state = 'closed';
    issue.updatedAt = nowIso();
    return { __type: 'CloseIssuePayload', issue: issueTag(repo, issue) };
  }
  if (field === 'createPullRequest') {
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    if (!decoded || decoded.kind !== 'Repository') throw new GraphQLError('createPullRequest: repositoryId is not a Repository id');
    const repo = ctx.store.getRepo(decoded.parts[0], decoded.parts[1]);
    if (!repo) throw new GraphQLError('createPullRequest: repository not found');
    const pull = ctx.store.createPull(
      repo,
      String(input.headRefName ?? ''),
      String(input.baseRefName ?? ''),
      String(input.title ?? ''),
      String(input.body ?? ''),
    );
    return { __type: 'CreatePullRequestPayload', pullRequest: pullTag(repo, pull) };
  }
  if (field === 'mergePullRequest') {
    const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
    if (!decoded || decoded.kind !== 'PullRequest') throw new GraphQLError('mergePullRequest: pullRequestId is not a PullRequest id');
    const repo = ctx.store.getRepo(decoded.parts[0], decoded.parts[1]);
    const pull = repo ? ctx.store.getPull(repo, parseInt(decoded.parts[2], 10)) : null;
    if (!repo || !pull) throw new GraphQLError('mergePullRequest: pull request not found');
    ctx.store.mergePull(repo, pull);
    return { __type: 'MergePullRequestPayload', pullRequest: pullTag(repo, pull) };
  }
  if (field === 'addComment') {
    const decoded = decodeGlobalId(String(input.subjectId ?? ''));
    if (!decoded || decoded.kind !== 'Issue') throw new GraphQLError('addComment: subjectId is not an Issue id');
    const repo = ctx.store.getRepo(decoded.parts[0], decoded.parts[1]);
    const issue = repo ? ctx.store.getIssue(repo, parseInt(decoded.parts[2], 10)) : null;
    if (!repo || !issue) throw new GraphQLError('addComment: issue not found');
    const comment = ctx.store.addComment(repo, issue.number, String(input.body ?? ''));
    return {
      __type: 'AddCommentPayload',
      commentEdge: {
        __type: 'IssueCommentEdge',
        node: { __type: 'IssueComment', repo, issue, comment },
        cursor: cursorFor(comment.id),
      },
    };
  }
  throw new GraphQLError(`Cannot query field "${field}" on type "Mutation".`);
}

function resolveRepository(ctx: ExecContext, parent: Tagged, field: string, args: Record<string, unknown>): unknown {
  const repo = parent.repo as Repo;
  switch (field) {
    case 'id':
      return globalId('Repository', repo.owner, repo.name);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.owner}/${repo.name}`;
    case 'owner':
      return userTag();
    case 'defaultBranchRef': {
      const tip = ctx.store.resolveRef(repo, repo.defaultBranch);
      return tip ? { __type: 'Ref', name: repo.defaultBranch } : null;
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'description':
      return repo.description;
    case 'private':
      return repo.private;
    case 'url':
      return `https://github.com/${repo.owner}/${repo.name}`;
    case 'createdAt':
      return repo.createdAt;
    case 'updatedAt':
      return repo.updatedAt;
    case 'issue': {
      const issue = ctx.store.getIssue(repo, Number(args.number));
      return issue ? issueTag(repo, issue) : null;
    }
    case 'issues': {
      const states = (args.states as string[] | undefined) ?? null;
      const orderBy = (args.orderBy as { field?: string; direction?: string } | undefined) ?? {};
      const first = args.first as number | undefined;
      const after = cursorNumber(args.after as string | null | undefined);
      let list = ctx.store.listIssues(repo, { state: 'all' });
      if (states) {
        const wanted = new Set(states.map((s) => s.toLowerCase()));
        list = list.filter((i) => wanted.has(i.state));
      }
      const dir = (orderBy.direction ?? 'ASC') === 'DESC' ? -1 : 1;
      list.sort((a, b) => (a.number - b.number) * dir);
      if (after !== null) {
        list = list.filter((i) => (dir === 1 ? i.number > after : i.number < after));
      }
      const total = list.length;
      const page = first !== undefined ? list.slice(0, first) : list;
      const hasNext = first !== undefined && list.length > first;
      return {
        __type: 'IssueConnection',
        nodes: page.map((i) => issueTag(repo, i)),
        edges: page.map((i) => ({ __type: 'IssueEdge', node: issueTag(repo, i), cursor: cursorFor(i.number) })),
        pageInfo: pageInfoFor(page, total, hasNext),
        totalCount: total,
      };
    }
    case 'pullRequests': {
      const first = args.first as number | undefined;
      const states = (args.states as string[] | undefined) ?? null;
      let list = ctx.store.listPulls(repo, 'all');
      if (states) {
        const wanted = new Set(states);
        list = list.filter((p) => wanted.has(p.merged ? 'MERGED' : p.state.toUpperCase()));
      }
      const total = list.length;
      const page = first !== undefined ? list.slice(0, first) : list;
      return {
        __type: 'PullRequestConnection',
        nodes: page.map((p) => pullTag(repo, p)),
        edges: page.map((p) => ({ __type: 'IssueEdge', node: pullTag(repo, p), cursor: cursorFor(p.number) })),
        pageInfo: pageInfoFor(page, total, first !== undefined && list.length > first),
        totalCount: total,
      };
    }
    case 'pullRequest': {
      const pull = ctx.store.getPull(repo, Number(args.number));
      return pull ? pullTag(repo, pull) : null;
    }
    default:
      throw new GraphQLError(`Cannot query field "${field}" on type "Repository".`);
  }
}

function resolveIssue(ctx: ExecContext, parent: Tagged, field: string, args: Record<string, unknown>): unknown {
  const repo = parent.repo as Repo;
  const issue = parent.issue as Issue;
  switch (field) {
    case 'id':
      return globalId('Issue', repo.owner, repo.name, issue.number);
    case 'databaseId':
      return issue.id;
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'body':
      return issue.body;
    case 'state':
      return issue.state.toUpperCase();
    case 'url':
      return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
    case 'createdAt':
      return issue.createdAt;
    case 'updatedAt':
      return issue.updatedAt;
    case 'author':
      return userTag();
    case 'labels':
      return {
        __type: 'LabelConnection',
        nodes: issue.labels.map((l) => ({ __type: 'Label', id: globalId('Label', repo.owner, repo.name, l.name), name: l.name, color: l.color, description: '' })),
        totalCount: issue.labels.length,
      };
    case 'comments':
      return {
        __type: 'IssueCommentConnection',
        nodes: issue.comments.map((c) => ({ __type: 'IssueComment', repo, issue, comment: c })),
        totalCount: issue.comments.length,
      };
    default:
      throw new GraphQLError(`Cannot query field "${field}" on type "Issue".`);
  }
}

function resolvePullRequest(ctx: ExecContext, parent: Tagged, field: string, args: Record<string, unknown>): unknown {
  const repo = parent.repo as Repo;
  const pull = parent.pull as Pull;
  switch (field) {
    case 'id':
      return globalId('PullRequest', repo.owner, repo.name, pull.number);
    case 'databaseId':
      return pull.id;
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'body':
      return pull.body;
    case 'state':
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    case 'merged':
      return pull.merged;
    case 'mergedAt':
      return pull.mergedAt;
    case 'mergeCommit':
      return pull.mergeCommitSha ? { __type: 'Commit', oid: pull.mergeCommitSha } : null;
    case 'headRefName':
      return pull.headRef;
    case 'baseRefName':
      return pull.baseRef;
    case 'headRefOid':
      return pull.headSha;
    case 'baseRefOid':
      return pull.baseSha;
    case 'mergeable':
      return ctx.store.prMergeable(repo, pull);
    case 'url':
      return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
    case 'createdAt':
      return pull.createdAt;
    case 'updatedAt':
      return pull.updatedAt;
    case 'author':
      return userTag();
    case 'files': {
      const first = args.first as number | undefined;
      const files = ctx.store.prFiles(repo, pull);
      const page = first !== undefined ? files.slice(0, first) : files;
      const nodes = page.map((f) => ({
        __type: 'PullRequestChangedFile',
        path: f.filename,
        additions: f.additions,
        deletions: f.deletions,
        changeType: f.status.toUpperCase(),
      }));
      return {
        __type: 'PullRequestChangedFileConnection',
        nodes,
        edges: nodes.map((n, i) => ({ __type: 'IssueEdge', node: n, cursor: cursorFor(i + 1) })),
        pageInfo: {
          __type: 'PageInfo',
          hasNextPage: first !== undefined && files.length > first,
          hasPreviousPage: false,
          startCursor: page.length > 0 ? cursorFor(1) : null,
          endCursor: page.length > 0 ? cursorFor(page.length) : null,
          total: files.length,
        },
        totalCount: files.length,
      };
    }
    default:
      throw new GraphQLError(`Cannot query field "${field}" on type "PullRequest".`);
  }
}

function resolveIssueComment(_ctx: ExecContext, parent: Tagged, field: string, _args: Record<string, unknown>): unknown {
  const repo = parent.repo as Repo;
  const issue = parent.issue as Issue;
  const comment = parent.comment as { id: number; body: string; createdAt: string; updatedAt: string };
  switch (field) {
    case 'id':
      return globalId('IssueComment', repo.owner, repo.name, issue.number, comment.id);
    case 'body':
      return comment.body;
    case 'createdAt':
      return comment.createdAt;
    case 'updatedAt':
      return comment.updatedAt;
    case 'author':
      return userTag();
    default:
      throw new GraphQLError(`Cannot query field "${field}" on type "IssueComment".`);
  }
}

function resolveUser(_ctx: ExecContext, parent: Tagged, field: string, _args: Record<string, unknown>): unknown {
  const user = parent.user as typeof VIEWER;
  switch (field) {
    case 'id':
      return globalId('User', user.login);
    case 'login':
      return user.login;
    case 'name':
      return user.name;
    case 'email':
      return user.email;
    default:
      throw new GraphQLError(`Cannot query field "${field}" on type "User".`);
  }
}

function resolveField(ctx: ExecContext, typeName: string, parent: Tagged, field: string, args: Record<string, unknown>): unknown {
  switch (typeName) {
    case 'Query':
      return resolveQuery(ctx, field, args);
    case 'Mutation':
      return resolveMutation(ctx, field, args);
    case 'Repository':
      return resolveRepository(ctx, parent, field, args);
    case 'Issue':
      return resolveIssue(ctx, parent, field, args);
    case 'PullRequest':
      return resolvePullRequest(ctx, parent, field, args);
    case 'User':
      return resolveUser(ctx, parent, field, args);
    case 'IssueComment':
      return resolveIssueComment(ctx, parent, field, args);
    case '__Type':
    case '__Field':
    case '__EnumValue':
    case '__InputValue':
    case 'PageInfo':
    case 'Ref':
    case 'Label':
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'LabelConnection':
    case 'IssueCommentConnection':
    case 'IssueEdge':
    case 'IssueCommentEdge':
    case 'PullRequestChangedFile':
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
    case 'AddCommentPayload': {
      // Plain record fields (already stored on the tagged object).
      const value = (parent as Record<string, unknown>)[field];
      if (value === undefined) throw new GraphQLError(`Cannot query field "${field}" on type "${typeName}".`);
      return value;
    }
    default:
      throw new GraphQLError(`Cannot query field "${field}" on type "${typeName}".`);
  }
}

function executeSelections(
  ctx: ExecContext,
  typeName: string,
  parent: Tagged,
  selections: Selection[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition && sel.typeCondition !== typeName) continue;
      Object.assign(out, executeSelections(ctx, typeName, parent, sel.selections, variables));
      continue;
    }
    const responseKey = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    const def = SCHEMA[typeName];
    if (!def?.fields?.has(sel.name)) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".` });
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [k, v] of sel.args) args[k] = resolveValue(v, variables);
    let raw: unknown;
    try {
      raw = resolveField(ctx, typeName, parent, sel.name, args);
    } catch (e) {
      if (e instanceof StoreError) {
        ctx.errors.push({ message: e.message });
        out[responseKey] = null;
        continue;
      }
      if (e instanceof GraphQLError) {
        ctx.errors.push({ message: e.message });
        out[responseKey] = null;
        continue;
      }
      throw e;
    }
    out[responseKey] = executeValue(ctx, raw, sel.selections, variables);
  }
  return out;
}

function executeValue(
  ctx: ExecContext,
  raw: unknown,
  selections: Selection[],
  variables: Record<string, unknown>,
): unknown {
  if (raw === null || raw === undefined) return null;
  if (selections.length === 0) return raw;
  if (Array.isArray(raw)) {
    return raw.map((item) => executeValue(ctx, item, selections, variables));
  }
  if (typeof raw === 'object' && raw !== null && '__type' in (raw as Record<string, unknown>)) {
    const tagged = raw as Tagged;
    return executeSelections(ctx, tagged.__type, tagged, selections, variables);
  }
  return raw;
}

function executeOperation(
  ctx: ExecContext,
  op: Operation,
  variables: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors?: { message: string }[] } {
  const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: Tagged = { __type: rootType };
  const data = executeSelections(ctx, rootType, root, op.selections, variables);
  if (ctx.errors.length > 0) {
    return { data: null, errors: ctx.errors };
  }
  return { data };
}

/** Handle one GraphQL request body (single or batched). Returns the response
 * body object (or array for a batch). */
export function handleGraphql(store: Store, body: unknown): { status: number; body: unknown } {
  const isBatch = Array.isArray(body);
  const docs = isBatch ? (body as unknown[]) : [body];
  const results: unknown[] = [];
  for (const doc of docs) {
    const record = (doc ?? {}) as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    let ops: Operation[];
    try {
      ops = new Parser(query).parseDocument();
    } catch (e) {
      results.push({ data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] });
      continue;
    }
    const op = ops[0];
    if (!op) {
      results.push({ data: null, errors: [{ message: 'Empty GraphQL document' }] });
      continue;
    }
    const ctx: ExecContext = { store, errors: [] };
    try {
      results.push(executeOperation(ctx, op, variables));
    } catch (e) {
      results.push({ data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] });
    }
  }
  return { status: 200, body: isBatch ? results : results[0] };
}
