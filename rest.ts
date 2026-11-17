// rest.ts — the GitHub REST API v3 surface.
//
// Routes (all under /api/v3, all JSON, all carrying X-GitHub-Request-Id):
//   GET  /                       root + X-OAuth-Scopes
//   GET  /meta                   installed_version
//   GET  /user                   the token owner (scenario viewer)
//   GET  /user/repos             the viewer's repos, paginated (Link header)
//   POST /user/repos             create a repo (422 on a duplicate name)
//   GET/PATCH/DELETE /repos/{o}/{r}
//   GET  /repos/{o}/{r}/branches, /branches/{branch}
//   GET  /repos/{o}/{r}/git/refs/heads/{branch}
//   POST /repos/{o}/{r}/git/refs
//   GET  /repos/{o}/{r}/commits
//   GET/PUT/DELETE /repos/{o}/{r}/contents/{path}
//   POST /repos/{o}/{r}/labels
//   GET/POST /repos/{o}/{r}/issues, GET/PATCH /issues/{n}, GET/POST /issues/{n}/comments
//   GET/POST /repos/{o}/{r}/pulls, GET /pulls/{n}, GET /pulls/{n}/files, PUT /pulls/{n}/merge

import { globalId, nowIso, StoreError, VIEWER_IDENTITY, type Comment, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { VIEWER } from './scenario.ts';

export interface RestReply {
  status: number;
  body: unknown;
  contentType?: string;
  headers?: Record<string, string>;
}

export interface RestContext {
  method: string;
  segments: string[]; // path segments after /api/v3
  query: URLSearchParams;
  body: unknown;
  host: string;
  authed: boolean;
}

function json(status: number, body: unknown, headers?: Record<string, string>): RestReply {
  return { status, body, contentType: 'application/json', headers };
}

function notFound(message: string): RestReply {
  return json(404, { message });
}

function badRequest(message: string): RestReply {
  return json(400, { message });
}

function unauthorized(): RestReply {
  return json(401, { message: 'Requires authentication' });
}

function parseBody(body: unknown): Record<string, unknown> {
  if (body === null || body === undefined) return {};
  if (typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  throw new StoreError(400, 'Invalid JSON body');
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.owner, repo.name),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, avatar_url: '', type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: repo.issues.filter((i) => i.state === 'open').length,
    watchers: 0,
  };
}

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: globalId('User', VIEWER.login),
    name: VIEWER.name,
    email: VIEWER.email,
    type: 'User',
    avatar_url: '',
    html_url: `https://github.com/${VIEWER.login}`,
    url: `/api/v3/users/${VIEWER.login}`,
  };
}

function labelJson(label: { id: number; name: string; color: string }): Record<string, unknown> {
  return { id: label.id, node_id: globalId('Label', label.name), name: label.name, color: label.color, description: '', default: false, url: '' };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.owner, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map(labelJson),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', repo.owner, repo.name, issue.number, comment.id),
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.owner, repo.name, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'closed' : pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: null,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, user: { login: repo.owner } },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, user: { login: repo.owner } },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function branchJson(repo: Repo, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
  };
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; totalPages: number; pageNum: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), totalPages, pageNum, perPage };
}

function linkHeader(host: string, path: string, query: URLSearchParams, pageNum: number, totalPages: number, perPage: number): string {
  const build = (page: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(page));
    q.set('per_page', String(perPage));
    return `http://${host}${path}?${q.toString()}`;
  };
  const links: string[] = [];
  if (pageNum < totalPages) links.push(`<${build(pageNum + 1)}>; rel="next"`);
  if (totalPages > 1) links.push(`<${build(totalPages)}>; rel="last"`);
  links.push(`<${build(1)}>; rel="first"`);
  if (pageNum > 1) links.push(`<${build(pageNum - 1)}>; rel="prev"`);
  return links.join(', ');
}

export function handleRest(store: Store, ctx: RestContext): RestReply {
  if (!ctx.authed) return unauthorized();
  const { method, segments } = ctx;
  try {
    // Root and meta.
    if (segments.length === 0) {
      if (method !== 'GET') return notFound('Not Found');
      return json(200, {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        user_url: '/api/v3/users/{user}',
      }, { 'X-OAuth-Scopes': 'repo, read:org' });
    }
    if (segments[0] === 'meta') {
      if (method !== 'GET') return notFound('Not Found');
      return json(200, { installed_version: '1.0.0', version: '1.0.0', verifiable_password_authentication: true, git_hooks: [], git_ssh: false });
    }
    if (segments[0] === 'user') {
      if (segments.length === 1) {
        if (method !== 'GET') return notFound('Not Found');
        return json(200, userJson());
      }
      if (segments[1] === 'repos') {
        if (method === 'GET') {
          const repos = store.listRepos();
          const { page, totalPages, pageNum, perPage } = paginate(repos, ctx.query);
          const headers: Record<string, string> = {};
          if (totalPages > 1) {
            headers.Link = linkHeader(ctx.host, '/api/v3/user/repos', ctx.query, pageNum, totalPages, perPage);
          }
          return json(200, page.map(repoJson), headers);
        }
        if (method === 'POST') {
          const body = parseBody(ctx.body);
          const name = String(body.name ?? '');
          if (!name) return json(422, { message: 'name is required' });
          const repo = store.createRepo(name, String(body.description ?? ''), Boolean(body.private ?? false));
          return json(201, repoJson(repo));
        }
        return notFound('Not Found');
      }
      return notFound('Not Found');
    }
    if (segments[0] === 'repos' && segments.length >= 3) {
      return handleRepo(store, ctx, segments[1], segments[2], segments.slice(3));
    }
    return notFound('Not Found');
  } catch (e) {
    if (e instanceof StoreError) return json(e.status, { message: e.message });
    throw e;
  }
}

function handleRepo(store: Store, ctx: RestContext, owner: string, repoName: string, rest: string[]): RestReply {
  const { method } = ctx;
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound(`Repository ${owner}/${repoName} not found`);

  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoJson(repo));
    if (method === 'PATCH') {
      const body = parseBody(ctx.body);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch;
      repo.updatedAt = nowIso();
      return json(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return { status: 204, body: '' };
    }
    return notFound('Not Found');
  }

  const head = rest[0];

  // Branches.
  if (head === 'branches') {
    if (rest.length === 1) {
      if (method !== 'GET') return notFound('Not Found');
      const branches = [...repo.refs.entries()]
        .filter(([name]) => name.startsWith('refs/heads/'))
        .map(([name, sha]) => branchJson(repo, name.slice('refs/heads/'.length), sha))
        .sort((a, b) => ((a.name as string) < (b.name as string) ? -1 : 1));
      return json(200, branches);
    }
    const branchName = rest.slice(1).join('/');
    if (method !== 'GET') return notFound('Not Found');
    const sha = store.resolveRef(repo, branchName);
    if (!sha) return notFound(`Branch ${branchName} not found`);
    return json(200, branchJson(repo, branchName, sha));
  }

  // Git refs.
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const body = parseBody(ctx.body);
      const ref = String(body.ref ?? '');
      const sha = String(body.sha ?? '');
      if (!ref || !sha) return json(422, { message: 'ref and sha are required' });
      if (store.resolveRef(repo, ref) !== null) return json(422, { message: 'Reference already exists' });
      if (!store.getObject(repo, sha)) return json(422, { message: `Object ${sha} not found` });
      store.setRef(repo, ref, sha);
      return json(201, {
        ref,
        node_id: globalId('Ref', repo.owner, repo.name, ref),
        url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.replace('refs/', '')}`,
        object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` },
      });
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = rest.slice(2).join('/');
      const sha = store.resolveRef(repo, ref);
      if (!sha) return notFound(`Reference ${ref} not found`);
      return json(200, {
        ref: `refs/${ref}`,
        node_id: globalId('Ref', repo.owner, repo.name, `refs/${ref}`),
        url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref}`,
        object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` },
      });
    }
    return notFound('Not Found');
  }

  // Commits.
  if (head === 'commits') {
    if (method !== 'GET') return notFound('Not Found');
    const sha = ctx.query.get('sha') ?? undefined;
    const commits = store.listCommits(repo, sha);
    return json(200, commits.map((c) => ({
      sha: c.sha,
      commit: {
        message: c.message.replace(/\n$/, ''),
        author: { name: VIEWER.name, email: VIEWER.email, date: repo.createdAt },
        committer: { name: VIEWER.name, email: VIEWER.email, date: repo.createdAt },
        tree: { sha: c.tree },
      },
      author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      parents: c.parents.map((p) => ({ sha: p })),
      url: `/api/v3/repos/${owner}/${repoName}/commits/${c.sha}`,
    })));
  }

  // Contents.
  if (head === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') {
      const ref = ctx.query.get('ref') ?? undefined;
      const content = store.getContent(repo, path, ref);
      if (!content) return notFound(`File ${path} not found`);
      if (content.type === 'file') {
        return json(200, {
          type: 'file',
          encoding: 'base64',
          size: content.size,
          name: path.split('/').pop(),
          path,
          content: content.contentB64,
          sha: content.blobSha,
          url: `/api/v3/repos/${owner}/${repoName}/contents/${path}`,
          html_url: `https://github.com/${owner}/${repoName}/blob/${repo.defaultBranch}/${path}`,
          download_url: `/api/v3/repos/${owner}/${repoName}/contents/${path}?raw=1`,
        });
      }
      return json(200, content.entries.map((e) => ({
        type: e.type,
        name: e.name,
        path: e.path,
        sha: e.sha,
        size: e.size,
        url: `/api/v3/repos/${owner}/${repoName}/contents/${e.path}`,
        html_url: `https://github.com/${owner}/${repoName}/tree/${repo.defaultBranch}/${e.path}`,
        download_url: e.type === 'file' ? `/api/v3/repos/${owner}/${repoName}/contents/${e.path}?raw=1` : null,
      })));
    }
    if (method === 'PUT') {
      const body = parseBody(ctx.body);
      const message = String(body.message ?? '');
      const contentB64 = String(body.content ?? '');
      if (!message || !contentB64) return json(422, { message: 'message and content are required' });
      const branch = typeof body.branch === 'string' ? body.branch : undefined;
      const sha = typeof body.sha === 'string' ? body.sha : undefined;
      const result = store.putContent(repo, path, contentB64, message, branch, sha);
      return json(result.created ? 201 : 200, {
        content: { name: path.split('/').pop(), path, sha: result.blobSha, size: Buffer.from(contentB64.replace(/\s+/g, ''), 'base64').length, type: 'file', encoding: 'base64' },
        commit: { sha: result.commitSha, message, author: { name: VIEWER.name, email: VIEWER.email, date: repo.createdAt }, committer: { name: VIEWER.name, email: VIEWER.email, date: repo.createdAt } },
      });
    }
    if (method === 'DELETE') {
      const body = parseBody(ctx.body);
      const message = String(body.message ?? '');
      const branch = typeof body.branch === 'string' ? body.branch : undefined;
      const sha = typeof body.sha === 'string' ? body.sha : undefined;
      const result = store.deleteContent(repo, path, message, branch, sha);
      return json(200, {
        commit: { sha: result.commitSha, message, author: { name: VIEWER.name, email: VIEWER.email, date: repo.createdAt }, committer: { name: VIEWER.name, email: VIEWER.email, date: repo.createdAt } },
      });
    }
    return notFound('Not Found');
  }

  // Labels.
  if (head === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const body = parseBody(ctx.body);
      const name = String(body.name ?? '');
      if (!name) return json(422, { message: 'name is required' });
      const label = store.createLabel(repo, name, String(body.color ?? 'ededed'));
      return json(201, labelJson(label));
    }
    if (method === 'GET' && rest.length === 1) {
      return json(200, [...repo.labels.values()].map(labelJson));
    }
    return notFound('Not Found');
  }

  // Issues.
  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const issues = store.listIssues(repo, {
          state: ctx.query.get('state') ?? undefined,
          sort: ctx.query.get('sort') ?? undefined,
          direction: ctx.query.get('direction') ?? undefined,
        });
        const { page, totalPages, pageNum, perPage } = paginate(issues, ctx.query);
        const headers: Record<string, string> = {};
        if (totalPages > 1) {
          headers.Link = linkHeader(ctx.host, `/api/v3/repos/${owner}/${repoName}/issues`, ctx.query, pageNum, totalPages, perPage);
        }
        return json(200, page.map((i) => issueJson(repo, i)), headers);
      }
      if (method === 'POST') {
        const body = parseBody(ctx.body);
        const title = String(body.title ?? '');
        if (!title) return json(422, { message: 'title is required' });
        const labels = Array.isArray(body.labels) ? (body.labels as unknown[]).map(String) : [];
        const issue = store.createIssue(repo, title, String(body.body ?? ''), labels);
        return json(201, issueJson(repo, issue));
      }
      return notFound('Not Found');
    }
    const number = parseInt(rest[1], 10);
    if (!Number.isInteger(number)) return notFound('Not Found');
    const issue = store.getIssue(repo, number);
    if (!issue) return notFound(`Issue #${number} not found`);
    if (rest.length === 2) {
      if (method === 'GET') return json(200, issueJson(repo, issue));
      if (method === 'PATCH') {
        const body = parseBody(ctx.body);
        if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
          issue.state = body.state;
        }
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        issue.updatedAt = nowIso();
        return json(200, issueJson(repo, issue));
      }
      return notFound('Not Found');
    }
    if (rest[2] === 'comments') {
      if (method === 'GET') return json(200, issue.comments.map((c) => commentJson(repo, issue, c)));
      if (method === 'POST') {
        const body = parseBody(ctx.body);
        const comment = store.addComment(repo, number, String(body.body ?? ''));
        return json(201, commentJson(repo, issue, comment));
      }
      return notFound('Not Found');
    }
    return notFound('Not Found');
  }

  // Pull requests.
  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const pulls = store.listPulls(repo, ctx.query.get('state') ?? undefined);
        const { page, totalPages, pageNum, perPage } = paginate(pulls, ctx.query);
        const headers: Record<string, string> = {};
        if (totalPages > 1) {
          headers.Link = linkHeader(ctx.host, `/api/v3/repos/${owner}/${repoName}/pulls`, ctx.query, pageNum, totalPages, perPage);
        }
        return json(200, page.map((p) => pullJson(repo, p)), headers);
      }
      if (method === 'POST') {
        const body = parseBody(ctx.body);
        const headRef = String(body.head ?? '');
        const baseRef = String(body.base ?? '');
        const title = String(body.title ?? '');
        if (!headRef || !baseRef || !title) return json(422, { message: 'head, base and title are required' });
        const pull = store.createPull(repo, headRef, baseRef, title, String(body.body ?? ''));
        return json(201, pullJson(repo, pull));
      }
      return notFound('Not Found');
    }
    const number = parseInt(rest[1], 10);
    if (!Number.isInteger(number)) return notFound('Not Found');
    const pull = store.getPull(repo, number);
    if (!pull) return notFound(`Pull request #${number} not found`);
    if (rest.length === 2) {
      if (method === 'GET') return json(200, pullJson(repo, pull));
      return notFound('Not Found');
    }
    if (rest[2] === 'files' && method === 'GET') {
      const files = store.prFiles(repo, pull);
      return json(200, files.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        sha: f.sha,
        patch: '',
      })));
    }
    if (rest[2] === 'merge' && method === 'PUT') {
      const body = parseBody(ctx.body);
      const method2 = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
      if (method2 !== 'squash' && method2 !== 'merge' && method2 !== 'rebase') {
        return json(422, { message: `Unknown merge method ${method2}` });
      }
      const merged = store.mergePull(repo, pull);
      return json(200, { merged: true, sha: merged.sha, message: merged.message });
    }
    return notFound('Not Found');
  }

  return notFound('Not Found');
}
