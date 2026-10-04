// Stages a clean bundle dir (dist + production deps only) and packs it with the official MCPB CLI.
import { execSync } from "node:child_process";
import { cp, rm, mkdir, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const stage = path.join(root, ".mcpb-stage");
const out = path.join(root, "vcm-mcp.mcpb");
// shell:true joins args unquoted, so paths with spaces break -> build the command line ourselves.
// ponytail: the command name stays unquoted; cmd.exe mis-resolves a quoted "npm" shim.
const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
const run = (cmd, args, cwd) => execSync([cmd, ...args.map(q)].join(" "), { cwd, stdio: "inherit" });

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
for (const f of ["package.json", "package-lock.json", "manifest.json", "README.md", "dist"]) {
  await cp(path.join(root, f), path.join(stage, f), { recursive: true });
}
run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], stage); // ponytail: full prod tree; prune if the store complains
await rm(out, { force: true });
run("npx", ["-y", "@anthropic-ai/mcpb@latest", "pack", stage, out], root);
console.log(`bundle: ${out} (${((await stat(out)).size / 1024 / 1024).toFixed(1)} MB)`);
await rm(stage, { recursive: true, force: true });
