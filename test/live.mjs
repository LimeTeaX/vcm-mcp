// Runnable check against a real endpoint: node test/live.mjs [projectDir]
// Uses the same env as the server (.env of the project, then this package). No mock, no assertions on output shape.
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const entry = path.join(import.meta.dirname, "..", "dist", "index.js");
const work = process.argv[2]
  ? path.resolve(process.argv[2])
  : await mkdtemp(path.join(tmpdir(), "vcm-live-"));
if (!existsSync(path.join(work, ".env"))) {
  await copyFile(path.join(import.meta.dirname, "..", ".env"), path.join(work, ".env")); // real key, real endpoint
}

await mkdir(path.join(work, ".vcm"), { recursive: true });
const filler = "refactor the parser, keep the public API stable, tests live under test/. ".repeat(40);
const history = Array.from({ length: 24 }, (_, i) => ({
  role: i % 2 ? "user" : "assistant",
  content: `turn ${i}: ${filler}`,
}));
await writeFile(path.join(work, ".vcm", "history.json"), JSON.stringify(history, null, 2));
console.log(`seeded ${history.length} messages in ${work}/.vcm/history.json`);

const child = spawn(process.execPath, [entry], { cwd: work, stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => process.stderr.write(d));
let buf = "";
const waiters = new Map();
child.stdout.on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\n")) >= 0; ) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    const msg = JSON.parse(line || "{}");
    if (waiters.has(msg.id)) waiters.get(msg.id)(msg);
  }
});
let nextId = 0;
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 180000);
    waiters.set(id, (msg) => (clearTimeout(timer), resolve(msg)));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const call = async (name, args = {}) => {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return { text: r.result.content.map((c) => c.text ?? "").join("\n"), isError: !!r.result.isError };
};

try {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "live", version: "0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  console.log("\n--- get_token_status ---\n" + (await call("get_token_status")).text);
  const compact = await call("compact_memory", { target_percent: 40 });
  console.log("\n--- compact_memory ---\n" + compact.text);
  console.log("\n--- history after ---\n" + (await readFile(path.join(work, ".vcm", "history.json"), "utf8")).slice(0, 1200));
  if (compact.isError) process.exitCode = 1;
} finally {
  child.kill();
  if (child.exitCode === null) await new Promise((r) => child.once("exit", r));
}
