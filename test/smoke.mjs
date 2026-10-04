// Runnable check: spawns dist/index.js with a mock chat/completions endpoint, no network beyond 127.0.0.1.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const entry = path.join(import.meta.dirname, "..", "dist", "index.js");
const SUMMARY = "# SKILL.md\n\n## Context\n- smoke summary\n\n## State\n- ok\n";

let lastRequest = null;
const mock = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    lastRequest = JSON.parse(body);
    res.writeHead(200, { "content-type": "application/json" });
    // gateway shape: nested under "data" plus a stray SSE tail - the parser must survive both
    res.end(
      JSON.stringify({ data: { choices: [{ message: { role: "assistant", content: SUMMARY } }] }, success: true }) +
        "\ndata: [DONE]\n\n",
    );
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${mock.address().port}`;

const work = await mkdtemp(path.join(tmpdir(), "vcm-mcp-"));
await mkdir(path.join(work, ".vcm"), { recursive: true });
const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(60);
const history = Array.from({ length: 40 }, (_, i) => ({
  role: i % 2 ? "user" : "assistant",
  content: `msg ${i}: ${filler}`,
}));
await writeFile(path.join(work, ".vcm", "history.json"), JSON.stringify(history));
// config comes from the managed project's .env, not from the parent env: the MCP stdio client only forwards a whitelist
await writeFile(
  path.join(work, ".env"),
  `OPENAI_API_KEY=test\nOPENAI_BASE_URL=${base}\nOPENAI_MODEL=from-file\nVCM_CONTEXT_WINDOW=32768\n`,
);
const originalRaw = await readFile(path.join(work, ".vcm", "history.json"), "utf8");

const childEnv = { ...process.env, OPENAI_MODEL: "from-client" }; // .env must not clobber an env the client passed
delete childEnv.OPENAI_API_KEY;
delete childEnv.OPENAI_BASE_URL;
const child = spawn(process.execPath, [entry], {
  cwd: work,
  stdio: ["pipe", "pipe", "pipe"],
  env: childEnv,
});
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));

let buf = "";
const waiters = new Map();
child.stdout.on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\n")) >= 0; ) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (waiters.has(msg.id)) waiters.get(msg.id)(msg), waiters.delete(msg.id);
  }
});

let nextId = 0;
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`timeout: ${method}\n${stderr}`));
    }, 20000);
    waiters.set(id, (msg) => {
      clearTimeout(timer);
      msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const call = async (name, args = {}) => {
  const r = await rpc("tools/call", { name, arguments: args });
  return { text: r.content.map((c) => c.text ?? "").join("\n"), isError: !!r.isError };
};

try {
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const { tools } = await rpc("tools/list", {});
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["compact_memory", "get_token_status", "read_skill_md", "write_skill_md"],
  );

  const status = await call("get_token_status");
  const used = Number(status.text.match(/tokens: (\d+)/)?.[1]);
  assert.ok(used > 1000, `expected a sizable history, got ${used} tokens`);

  assert.match((await call("read_skill_md")).text, /not found/);

  const compact = await call("compact_memory", { target_percent: 40 });
  assert.ok(!compact.isError, compact.text);
  const m = compact.text.match(/(\d+) -> (\d+) tokens/);
  assert.ok(m, compact.text);
  const [before, after] = [Number(m[1]), Number(m[2])];
  assert.ok(after <= Math.ceil(before * 0.4), `${after} > 40% of ${before}`);
  assert.ok(after >= before * 0.3, `over-compacted: ${after} < 30% of ${before}`);

  const rewritten = JSON.parse(await readFile(path.join(work, ".vcm", "history.json"), "utf8"));
  assert.ok(rewritten.length < history.length, "history not shrunk");
  assert.match(rewritten[0].content, /\[compacted summary\]/);
  const counts = compact.text.match(/(\d+) summarized to \d+ tokens, (\d+) kept verbatim/);
  assert.ok(counts, compact.text);
  assert.ok(Number(counts[1]) + Number(counts[2]) >= history.length, "messages vanished: neither summarized nor kept");
  assert.equal(Number(counts[1]), history.length, "not every message reached the summarizer");
  assert.equal(lastRequest.model, "from-client", ".env clobbered an env var the client passed");
  assert.equal(lastRequest.messages[0].content.includes("SKILL.md"), true, "summary prompt missing");
  assert.equal(await readFile(path.join(work, ".vcm", "history.json.bak"), "utf8"), originalRaw, "backup mismatch");

  assert.match((await call("write_skill_md", { content: "# SKILL.md\n\nhello\n" })).text, /wrote/);
  assert.match((await call("read_skill_md")).text, /hello/);

  console.log(`smoke ok: ${compact.text.split("\n")[0]}`);
} finally {
  child.kill();
  // Windows: the child still holds its cwd, rmdir fails until it is reaped
  if (child.exitCode === null) await new Promise((r) => child.once("exit", r));
  mock.close();
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
