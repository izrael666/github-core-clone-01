[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/izrael666/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/izrael666/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-core-clone-01 — a GitHub-compatible git forge

A from-scratch, dependency-free implementation of the core of GitHub:
repositories, git smart HTTP, REST v3, GraphQL v4 and MCP — all in memory,
all in TypeScript (Node 22, standard library only, no install, no git
binary, no internet in the trial).

## What it serves

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}` — the env's boot probe |
| `GET /api/v3/` | 200, `X-OAuth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (protocol v2 + v0), `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

Details that matter:

- **Git, byte-exact.** SHA-1 objects (`commit`/`tree`/`blob`/`tag`) stored and
  served byte-for-byte, git-style tree sorting, plain `PACK` v2 with a SHA-1
  trailer. Protocol v2 (`ls-refs=unborn`, `fetch=shallow`,
  `object-format=sha1`) and v0, shallow fetch with `deepen` (boundary
  commits get `shallow` lines, client-shallow commits that are now interior
  get `unshallow` lines), fast-forward enforcement with the exact
  `non-fast-forward` reason, and a mixed push that applies the good ref and
  reports one line per ref.
- **REST v3.** Repos (create 201, duplicate 422 with "already exists"),
  branches and git refs, commits per branch, contents (create 201 / update
  200 / stale sha 409, works on an unborn repo, branch creation from the
  default tip), labels, issues (numbers increment per repo from 1, unknown
  label 422, sort/filter/pagination with `Link` headers), comments, and
  pull requests (duplicate open PR from the same head 422, squash merge
  with the conflict rule, 405 on a conflicted or already-merged PR).
- **GraphQL v4.** A mini parser + executor for the 18 documents the
  harness sends: operation names, variables, aliases, inline fragments,
  inline enum lists, inline input objects, null variables and batched
  requests. Global ids are opaque (base64 of a type-prefixed string) and
  stable across reads; `node(id:)` round-trips repositories; unknown
  fields answer HTTP 200 with an `errors` array.
- **MCP.** Modern `server/discover` (2026-07-28) plus the legacy
  `initialize` handshake. Six tools — `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request` — acting on the same store as REST, so an object
  created over MCP is the same object over REST with stable ids.
- **Identity.** The token owner is derived from the scenario seed itself
  (the same xorshift64\* generator the kit uses), so `GET /api/v3/user`
  answers the scenario viewer `adaiversen` (id 1000) without the harness
  ever telling the entry who that is.

## How to run

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later. There is
nothing to install: the program imports `node:http`, `node:crypto` and
`node:zlib` plus its own modules only. `main.ts` is the starter lifecycle
(kept as-is): bind an ephemeral port, register it at `$MAKEFUN_ENV_URL`,
poll `/done`, exit 0.

## Layout

- `main.ts` — the entry ↔ env lifecycle (starter, unchanged).
- `app.ts` — the HTTP server: routing, auth, body reading, responses.
- `store.ts` — the in-memory forge: repos, git objects and refs, issues,
  pull requests, labels, comments, contents-as-commits, squash merge,
  diff and the merge-conflict rule.
- `gitcore.ts` — the git object model, pack codec and pkt-line framing.
- `gitproto.ts` — git smart HTTP: v0/v2 advertisement, ls-refs, fetch
  planning, receive-pack.
- `graphql.ts` — the GraphQL v4 parser + executor.
- `mcp.ts` — the MCP JSON-RPC endpoint and its six tools.
- `rest.ts` — the REST v3 handlers.
- `scenario.ts` — the scenario identity (viewer derivation from the seed).
- `package.json`, `tsconfig.json`, `LICENSE` (MIT).

## Local verification

Graded with the kit's own runner
(`node --experimental-strip-types sdk/run.ts --url <entry> --token <token> --perf`)
against a fresh server, 2026-11-17:

- **Conformance: 120/120** — git 30/30, repos 15/15, issues 15/15,
  pulls 20/20, protocol 5/5, GraphQL 20/20, MCP 15/15.
- **Perf: 183/200** — push 43, clone 46, read 50, write 44
  (p50: push 589 ms, clone 84 ms, read 632 ms, write 123 ms).
- **Total: 983/1000** (feature 600 + agent 200 + perf 183).

## Rules and limits

The rules, scoring weights, deadline and prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section).
In short: Node 22 only, no dependencies at run time, no internet and no
`git` binary in the trial; the repository is mounted read-only at `/bot`
and the entry may write under `/tmp` only. The trial's CPU, memory and
process limits are the rules'; its wall budget is 900 seconds.
