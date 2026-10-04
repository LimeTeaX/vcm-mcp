// Publishes vcm-mcp.mcpb to the Smithery registry without @smithery/cli.
// Why: the CLI forwards manifest.tools as serverCard.tools verbatim, the registry requires an
// inputSchema object on every tool, and MCPB's manifest schema (strictObject {name, description})
// forbids inputSchema in manifest.json - so `smithery mcp publish` 400s on any bundle with tools.
// Usage: node scripts/publish.mjs [namespace/name]   (token: SMITHERY_API_KEY or the CLI settings)
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Blob } from "node:buffer";
import { homedir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const bundle = path.join(root, "vcm-mcp.mcpb");
if (!existsSync(bundle)) {
  console.error(`${bundle} not found - run \`npm run bundle\` first`);
  process.exit(1);
}

const settingsPath = [
  process.env.APPDATA && path.join(process.env.APPDATA, "smithery", "settings.json"),
  path.join(homedir(), ".config", "smithery", "settings.json"),
  path.join(homedir(), "Library", "Application Support", "smithery", "settings.json"),
].find((p) => p && existsSync(p));
const settings = settingsPath ? JSON.parse(await readFile(settingsPath, "utf8")) : {};
const apiKey = process.env.SMITHERY_API_KEY ?? settings.apiKey;
const qualified = process.argv[2] ?? (settings.namespace && `${settings.namespace}/${manifest.name}`);
const [namespace, slug] = (qualified ?? "").split("/");
if (!apiKey || !namespace || !slug) {
  console.error("usage: node scripts/publish.mjs <namespace>/<name>   (auth: SMITHERY_API_KEY or `npx -y @smithery/cli@latest auth login`)");
  process.exit(1);
}

// mirrors what the CLI sends: user_config -> configSchema. Tool schemas are empty objects; the real
// ones are the zod definitions in src/index.ts and reach clients over the wire at connect time.
// ponytail: inline the real arg schemas here when the Smithery tool list needs to display them.
const userConfig = Object.entries(manifest.user_config ?? {});
const configSchema = {
  type: "object",
  properties: Object.fromEntries(
    userConfig.map(([k, v]) => [
      k,
      {
        type: v.type === "directory" || v.type === "file" ? "string" : v.type,
        ...(v.title ? { title: v.title } : {}),
        ...(v.description ? { description: v.description } : {}),
        ...(v.default !== undefined ? { default: v.default } : {}),
      },
    ])
  ),
  required: userConfig.filter(([, v]) => v.required).map(([k]) => k),
};
const payload = {
  type: "stdio",
  runtime: "node",
  serverCard: {
    serverInfo: { name: manifest.name, version: manifest.version },
    ...(manifest.tools ? { tools: manifest.tools.map((t) => ({ ...t, inputSchema: { type: "object", properties: {} } })) } : {}),
  },
  configSchema,
};

const api = "https://api.smithery.ai";
const headers = { authorization: `Bearer ${apiKey}` };
const created = await fetch(`${api}/namespaces/${namespace}/servers/${slug}`, {
  method: "PUT", // upsert: creates the server on first publish, no-op afterwards
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify({ displayName: manifest.name, description: manifest.description }),
});
if (!created.ok) console.error(`create ${created.status}: ${await created.text()}`); // deploy below reports the real failure

const body = new FormData();
body.append("payload", JSON.stringify(payload));
body.append("bundle", new Blob([await readFile(bundle)], { type: "application/octet-stream" }), path.basename(bundle));
const res = await fetch(`${api}/servers/${encodeURIComponent(qualified)}/releases`, { method: "PUT", headers, body });
const text = await res.text();
if (!res.ok) {
  console.error(`deploy failed: ${res.status} ${text}`);
  process.exit(1);
}
const { deploymentId, status, mcpUrl } = JSON.parse(text);
console.log(`released ${qualified} (${deploymentId}, ${status})`);
console.log(`${mcpUrl ?? ""}\nhttps://smithery.ai/servers/${qualified}`);
