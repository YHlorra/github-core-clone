# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/YHlorra/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/YHlorra/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node process: git smart HTTP (upload-pack protocol v2, receive-pack v0 with report-status and side-band-64k), the REST v3 API under `/api/v3`, the GraphQL v4 API at `/api/graphql`, and a Model Context Protocol endpoint at `/mcp` speaking revision 2026-07-28. No dependencies, no `git` binary, no outside service: packfiles, objects, refs, issues, pull requests and merges are all its own, in memory.

## What it serves

| Surface | Path | What a client gets |
|---|---|---|
| git smart HTTP | `/{owner}/{repo}.git` | `info/refs?service=git-upload-pack` (v2: `ls-refs`, `fetch`, shallow, `object-info`), `git-receive-pack` with v0 ref advertisement and push, delta-resolving packfile reader and its own packfile writer |
| REST v3 | `/api/v3/...` | repos, contents, labels, issues, pull requests, merges; JSON on every reply with a non-empty `X-GitHub-Request-Id`, `Link: rel="next"` paging, 401 without the bearer token, 404 as JSON |
| GraphQL v4 | `/api/graphql` | its own parser and executor, introspection for `Issue`, `PullRequest`, `Repository` and `SearchType`, batched operations, `data.repository = null` for an unknown repo |
| MCP | `/mcp` | JSON-RPC 2.0 over Streamable HTTP: `server/discover`, `tools/list` (six tools: `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`), `tools/call` acting on the same store REST reads |

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, `POST`s it to `$MAKEFUN_ENV_URL/register`, polls `$MAKEFUN_ENV_URL/done` and exits 0 when the suite is finished; `GET /healthz` answers `{"ok":true}` the whole time. Outside a trial, start it the same way and read the port from its first line.

## Layout

| File | Job |
|---|---|
| `main.ts` | process lifecycle: bind, register, poll for done, exit |
| `app.ts` | routes every request to the four surfaces |
| `lib/pktline.ts` | pkt-line encoding and decoding |
| `lib/git-objects.ts` | blob, tree, commit and tag objects, zlib on disk-free storage |
| `lib/pack.ts` | packfile reader (OFS and REF deltas) and writer |
| `lib/model.ts` | the forge's store: repos, refs, objects, issues, pulls, merges, a deterministic clock |
| `lib/githttp.ts` | capability advertisement, `ls-refs`, `fetch`, shallow clones, `receive-pack` |
| `lib/rest.ts` | REST v3 resources and their paging, errors and headers |
| `lib/graphql.ts` | GraphQL parser, executor and introspection |
| `lib/mcp.ts` | MCP discovery, `tools/list` and `tools/call` |
| `lib/http.ts` | JSON replies, request ids, error bodies |

---

<sub>Entered on [make.fun](https://make.fun/?ref=zz00e0w4&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
