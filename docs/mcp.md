# MCP servers

Milo can call tools that live outside it: any [MCP](https://modelcontextprotocol.io) server over
stdio. There is no SDK and no handshake library — the wire is hand-rolled, the same way the providers
are.

Servers are written in `~/.milo/mcp.json`, by hand, because a server *is* a command line:

```json
{
  "servers": {
    "notes": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/you/notes"],
      "readOnly": ["read_file", "list_directory"]
    }
  }
}
```

- `command`, `args`, `env`, `cwd` — what is launched, and where. `env` is added to Milo's own, and a
  `${VAR}` in a value is read from the environment, so a token stays out of the file. A variable that
  is not set is an error naming the field, not an empty value the server reads as "not authenticated".
- `enabled` — off keeps it out of the catalog without deleting what it took to set up, and stops its
  process.
- `readOnly` — the **server's** names for tools that only read. Those never ask; every other tool asks
  unless the permission policy says otherwise. A server's own `readOnlyHint` is deliberately ignored:
  an annotation is untrusted by the spec's own words, and a server does not get to answer the
  permission question about itself.
- `timeoutMs` — how long one call may take before it is abandoned (default 120000).
- A misspelled field is an error naming the ones that exist, and an invalid server name is an error
  too: the name becomes the prefix of every tool, so it takes single `_`/`-` separators only — a `__`
  would make `mcp__<server>__<tool>` ambiguous to read back.

Every server tool arrives as `mcp__<server>__<tool>`, and reads as `<server>: <tool>` on the surfaces,
with a 🔌 instead of the usual tool icon. Its description carries Milo's own line saying the tool comes
from an external server and that its output is untrusted data. The server's JSON Schema is sent to the
model **verbatim** — converted to Milo's own shape and back it would be Milo's reading of someone
else's contract.

**What it costs at startup is nothing.** There are three parts to that, and they are the design:

1. `~/.milo/mcp-cache.json` holds what each server last said its tools were, and the catalog is
   assembled from it — synchronously, before anything runs. The first turn has the tools the last run
   had, with no process and no round trip.
2. Connecting happens in the background, once per process, never awaited. An `npx` server that takes
   four seconds to boot is ready long before the person has finished typing.
3. A tool call dials if it has to. The connection is what a call waits for, which is where waiting
   belongs, and the tool line on every surface shows it running while it does.

`tools/list` is asked for once per connection, not once per turn; a `notifications/tools/list_changed`
re-lists and moves the catalog, taking a tool back out if the server dropped it. The era probe costs
one round trip on the first connect only: the cache remembers whether a server is modern
(`2026-07-28`, per-request metadata, `server/discover`) or legacy (`initialize` handshake), and a
wrong guess falls back to the probe.

```bash
milo mcp                    # the servers, and what the catalog holds from each
milo mcp check github       # connect now and list what it offers
milo mcp disable github     # out of the catalog, and its process stopped
milo mcp enable github
```

`check` is the verb that spawns servers, and it is where a failure is read in the server's own words —
including the last lines of its stderr. A server that will not start keeps its cached tools in the
catalog (they work again the moment it is back) and reports why in `milo mcp`, on the Tools screen of
the web settings, and in one `[milo]` line at startup. A server that dies mid-turn answers the call
with the failure instead of an empty result.

Milo speaks **stdio only** for now, and only the tools capability: resources, prompts and the
HTTP transport are not implemented, so a server configured for anything else has nothing to
call.
