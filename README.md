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

This is a local stdio server, so Smithery distributes it as an MCPB bundle (not a hosted URL).

```
npm run bundle                    # -> vcm-mcp.mcpb (~13 MB, dist + production deps + manifest.json)
npx -y @anthropic-ai/mcpb@latest validate manifest.json
```

Publishing needs an account token and must be done in an interactive terminal (browser login):

```
npx -y @smithery/cli@latest auth login          # prints an auth_url; open it, then the process finishes
npx -y @smithery/cli@latest namespace list      # pick the namespace (org) the server goes under
npx -y @smithery/cli@latest mcp publish vcm-mcp.mcpb -n <namespace>/vcm-mcp
```

The old top-level `smithery publish` was removed in CLI v4; the current form is `smithery mcp publish`.

`user_config` in `manifest.json` maps to env vars at install time: `project_dir` → `VCM_ROOT`,
`api_key` → `OPENAI_API_KEY`, `base_url` → `OPENAI_BASE_URL`, `model` → `OPENAI_MODEL`.

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
