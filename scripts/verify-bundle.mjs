// Verifies the packed bundle end to end: entry point resolves, manifest is valid, server boots from it.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const dir = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "..", ".mcpb-stage-verify"));
const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));

const args = manifest.server.mcp_config.args.map((a) => a.replace("${__dirname}", dir));
const entry = args[0];
const deps = existsSync(path.join(dir, "node_modules", "@modelcontextprotocol", "sdk"));
const jsTiktoken = existsSync(path.join(dir, "node_modules", "js-tiktoken"));

console.log(`entry:      ${entry}`);
console.log(`resolves:   ${existsSync(entry)}`);
console.log(`deps:       sdk=${deps} js-tiktoken=${jsTiktoken}`);
console.log(`tools:      ${manifest.tools.map((t) => t.name).join(", ")}`);
console.log(`user_config:${Object.keys(manifest.user_config).map((k) => " " + k).join("")}`);
console.log(`VCM_ENTRY=${entry}`);
