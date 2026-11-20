# github-core-clone-01

A GitHub-compatible git forge that runs in one Node 22 process, using only the
standard library: no dependencies, no `git` binary, every object in memory.

## Running

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the contest lifecycle: it binds an ephemeral port, registers the port
with `$MAKEFUN_ENV_URL/register`, and exits once the environment reports done.
`app.ts` builds the HTTP surface.

## Surface

| Path | What answers it |
| --- | --- |
| `GET /healthz` | liveness probe |
| `GET /api/v3/`, `/api/v3/...` | REST v3: repos, contents, labels, issues, pulls, merge |
| `POST /api/graphql` | GraphQL v4: repository/issue/pull reads, mutations, introspection |
| `POST /mcp` | MCP: JSON-RPC 2.0 over streamable HTTP with six repo/issue/pull tools |
| `/{owner}/{repo}.git/...` | smart-HTTP git: `info/refs`, `git-upload-pack`, `git-receive-pack` |

## Modules

| File | Job |
| --- | --- |
| `app.ts` | request dispatch, auth, error mapping |
| `lib\http.ts` | JSON replies, body reading, `ApiError`, request ids |
| `lib\pktline.ts` | pkt-line framing for the git wire protocol |
| `lib\git-objects.ts` | loose object encoding: blobs, trees, commits, tags |
| `lib\pack.ts` | packfile reading (including OFS/REF deltas) and writing |
| `lib\model.ts` | the in-memory forge: repos, refs, objects, issues, pulls, merges |
| `lib\githttp.ts` | protocol v0/v2 advertisement, ls-refs, fetch, receive-pack |
| `lib\rest.ts` | the REST v3 resources |
| `lib\graphql.ts` | GraphQL document parser, executor and schema introspection |
| `lib\mcp.ts` | MCP discovery, tool listing and tool calls |

Time in replies is deterministic: it derives from `MAKEFUN_TRIAL_NOW` (or a fixed
epoch), advanced one second per read, so identical requests replay identically.
