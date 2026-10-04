# vcm-mcp

MCP server (TypeScript, stdio, localhost only) for token-aware compaction of `.vcm/history.json` into SKILL.md format.

## Tools

| Tool | Args | Effect |
| --- | --- | --- |
| `get_token_status` | – | token usage of `.vcm/history.json` vs context window (js-tiktoken, gpt-4o `o200k_base`) |
| `compact_memory` | `target_percent` (default 40) | summarizes oldest messages via an OpenAI-compatible endpoint, keeps result at `target_percent`% of original tokens |
| `read_skill_md` | `path` (default `SKILL.md`) | reads a SKILL.md file |
| `write_skill_md` | `content`, `path` | atomically writes a SKILL.md file |

## Build / run

```
npm install
npm run build
node dist/index.js        # cwd = the project whose .vcm/ and SKILL.md you manage
```

MCP client config (Claude Desktop / Cursor):

```json
{
  "mcpServers": {
    "vcm": {
      "command": "node",
      "args": ["D:/Project Jackson/vcm-mcp/dist/index.js"],
      "env": { "OPENAI_API_KEY": "sk-..." }
    }
  }
}
```

## Publish to Smithery

Published: <https://smithery.ai/servers/jacksonmajuoke/vcm-mcp>

This is a local stdio server, so Smithery distributes it as an MCPB bundle (not a hosted URL).

```
npm run bundle                  # -> vcm-mcp.mcpb (~13 MB, dist + production deps + manifest.json)
npm run bundle:verify
npx -y @smithery/cli@latest auth login      # one-time browser login; also writes the token the script reads
npm run publish:smithery -- <namespace>/vcm-mcp
```

`scripts/publish.mjs` calls the registry API directly: `@smithery/cli@4.11.1` forwards `manifest.tools` to
the registry as-is, the registry requires an `inputSchema` object per tool, and MCPB's manifest schema forbids
`inputSchema` — so the CLI cannot publish a bundle that declares tools. The script reads the API key from the
Smithery CLI settings file (or `SMITHERY_API_KEY`), upserts `<namespace>/vcm-mcp` and uploads the bundle.

`user_config` in `manifest.json` maps to env vars at install time: `project_dir` → `VCM_ROOT`,
`api_key` → `OPENAI_API_KEY`, `base_url` → `OPENAI_BASE_URL`, `model` → `OPENAI_MODEL`.

Two limits of the stdio bundle, both expected:

- No MCP URL: `https://vcm-mcp--jacksonmajuoke.run.tools` answers `404 Server not found` (the registry
  records the `runToolsSlug` regardless; nothing is hosted until the bundle runs).
- Not in the directory search: `smithery.ai/servers` indexes remote (`remote: true`) servers only.
  The page itself is public.

To get a hosted URL and a search listing, port `src/index.ts` to Smithery's remote `createServer`
format and run `smithery deploy` — add only if a hosted endpoint is actually needed.

## Env

Any OpenAI-compatible endpoint works (`/chat/completions`); DeepSeek is the default so the $0 setup works out of the box.

- `OPENAI_API_KEY` – required for `compact_memory`
- `OPENAI_BASE_URL` – default `https://api.deepseek.com` (e.g. `https://api.openai.com/v1`, `http://127.0.0.1:11434/v1`)
- `OPENAI_MODEL` – default `deepseek-chat`
- `VCM_CONTEXT_WINDOW` – default `65536` (used only for the % report in `get_token_status`)

### Where the key goes

The MCP stdio client only forwards a whitelist of env vars (`PATH`, `APPDATA`, `TEMP`, …), so keys exported in your
shell generally do **not** reach the server. Put them in one of:

1. `.env` in the project you run the server against (recommended – keeps the key out of client configs)
2. `.env` in this package (loaded only if the project has none)
3. `env` in the MCP client config, which always wins over `.env`

`process.env` values passed by the client are never overwritten by `.env`. Start from `.env.example`.

## Test

```
npm test                       # builds, then runs test/smoke.mjs against a local mock chat/completions server
node test/live.mjs [projectDir] # seeds .vcm/history.json and hits the real endpoint from .env (temp dir by default)
```

Every message is fed to the summarizer, so nothing can be dropped; the newest ones are additionally kept verbatim (duplication of already-summarized content, by design). `summarize()` takes one API call per compaction; skipped: a re-summarize loop for exact targets, config file, HTTP transport → add only when the single-pass heuristic proves too coarse in real sessions.
