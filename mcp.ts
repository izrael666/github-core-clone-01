// mcp.ts — the Model Context Protocol endpoint (POST /mcp).
//
// JSON-RPC 2.0 over streamable HTTP (plain application/json answers; no
// SSE). Two eras are supported:
//   modern 2026-07-28: `server/discover` returns supportedVersions,
//     capabilities and serverInfo (also mirrored into
//     _meta['io.modelcontextprotocol/serverInfo']);
//   legacy 2025-11-25: `initialize` + `notifications/initialized`.
// The six tools act on the same store as REST, so an object created over
// MCP is the same object over REST (and its ids are stable).

import { StoreError, type Store } from './store.ts';
import { VIEWER } from './scenario.ts';

export interface McpReply {
  status: number;
  body: Buffer | string;
  contentType: string;
}

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    required: string[];
  };
}

/** Frozen once: tools/list must be byte-identical across calls. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];
Object.freeze(TOOLS);

function repoJson(store: Store, owner: string, repoName: string): Record<string, unknown> | null {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return null;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueJson(repo: { owner: string; name: string }, issue: { id: number; number: number; title: string; body: string; state: string; labels: { name: string }[]; comments: unknown[]; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name })),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: { owner: string; name: string }, pull: { id: number; number: number; title: string; body: string; state: string; merged: boolean; mergedAt: string | null; mergeCommitSha: string | null; headRef: string; baseRef: string; headSha: string; baseSha: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'merged' : pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function toolResult(result: unknown): { content: { type: 'text'; text: string }[]; structuredContent: unknown; isError: false } {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    isError: false,
  };
}

function toolError(message: string): { content: { type: 'text'; text: string }[]; structuredContent: { error: string }; isError: true } {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): unknown {
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  switch (name) {
    case 'create_repo': {
      const repo = store.createRepo(String(args.name ?? ''), String(args.description ?? ''), Boolean(args.private ?? false));
      const json = repoJson(store, repo.owner, repo.name);
      return toolResult(json);
    }
    case 'get_repo': {
      const json = repoJson(store, owner, repoName);
      if (!json) throw new StoreError(404, `Repository ${owner}/${repoName} not found`);
      return toolResult(json);
    }
    case 'create_issue': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) throw new StoreError(404, `Repository ${owner}/${repoName} not found`);
      const issue = store.createIssue(repo, String(args.title ?? ''), String(args.body ?? ''), []);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) throw new StoreError(404, `Repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = store.listIssues(repo, { state });
      return toolResult(issues.map((i) => issueJson(repo, i)));
    }
    case 'create_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) throw new StoreError(404, `Repository ${owner}/${repoName} not found`);
      const pull = store.createPull(
        repo,
        String(args.head ?? ''),
        String(args.base ?? ''),
        String(args.title ?? ''),
        String(args.body ?? ''),
      );
      return toolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) throw new StoreError(404, `Repository ${owner}/${repoName} not found`);
      const pull = store.getPull(repo, Number(args.pull_number));
      if (!pull) throw new StoreError(404, `Pull request #${args.pull_number} not found`);
      const merged = store.mergePull(repo, pull);
      return toolResult({ ...pullJson(repo, pull), merge_sha: merged.sha });
    }
    default:
      throw new StoreError(404, `Unknown tool ${name}`);
  }
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function extractId(raw: string): string | number | null {
  const m = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(raw);
  if (!m) return null;
  const v = m[1];
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return null;
    }
  }
  return parseInt(v, 10);
}

/** Handle a POST /mcp body. `authed` is false when no valid token was sent. */
export function handleMcp(store: Store, rawBody: string, authed: boolean): McpReply {
  const json = (obj: unknown): McpReply => ({
    status: 200,
    body: JSON.stringify(obj),
    contentType: 'application/json',
  });
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(rawBody) as JsonRpcRequest;
  } catch {
    return {
      status: 400,
      body: JSON.stringify(rpcError(extractId(rawBody), -32700, 'Parse error')),
      contentType: 'application/json',
    };
  }
  if (typeof req !== 'object' || req === null || Array.isArray(req)) {
    return { status: 400, body: JSON.stringify(rpcError(null, -32600, 'Invalid Request')), contentType: 'application/json' };
  }
  const id = req.id ?? null;
  const method = req.method ?? '';

  // Notifications have no id and get a 202 with an empty body.
  if (method === 'notifications/initialized') {
    return { status: 202, body: '', contentType: 'application/json' };
  }

  if (!authed) {
    return { status: 401, body: JSON.stringify({ message: 'Requires authentication' }), contentType: 'application/json' };
  }

  if (method === 'server/discover') {
    return json(
      rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      }),
    );
  }

  if (method === 'initialize') {
    return json(
      rpcResult(id, {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      }),
    );
  }

  if (method === 'tools/list') {
    return json(rpcResult(id, { tools: TOOLS }));
  }

  if (method === 'tools/call') {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const def = TOOLS.find((t) => t.name === name);
    if (!def) {
      return json(rpcError(id, -32602, `Unknown tool: ${name}`));
    }
    const missing = def.inputSchema.required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
    if (missing.length > 0) {
      return json(rpcResult(id, toolError(`Missing required argument(s): ${missing.join(', ')}`)));
    }
    try {
      return json(rpcResult(id, callTool(store, name, args)));
    } catch (e) {
      if (e instanceof StoreError) {
        return json(rpcResult(id, toolError(e.message)));
      }
      return json(rpcError(id, -32603, e instanceof Error ? e.message : String(e)));
    }
  }

  if (method === 'ping') {
    return json(rpcResult(id, {}));
  }

  return json(rpcError(id, -32601, `Method not found: ${method}`));
}
