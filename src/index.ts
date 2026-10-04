#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getEncoding } from "js-tiktoken";
import { z } from "zod";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// .env of the managed project first, then the one next to this package; never overrides env the MCP client passed
for (const f of [path.join(process.cwd(), ".env"), fileURLToPath(new URL("../.env", import.meta.url))]) {
  try {
    process.loadEnvFile(f);
  } catch {
    // ponytail: no .env is the normal case
  }
}

const ROOT = process.cwd();
const VCM_DIR = path.join(ROOT, ".vcm");
const HISTORY_FILE = path.join(VCM_DIR, "history.json");
const DEFAULT_SKILL = path.join(ROOT, "SKILL.md");
const CONTEXT_WINDOW = Number(process.env.VCM_CONTEXT_WINDOW ?? 65536);

const enc = getEncoding("o200k_base"); // gpt-4o tokenizer
const tokens = (text: string) => enc.encode(text).length;

// any OpenAI-compatible endpoint; DeepSeek default keeps the $0 setup working out of the box
const API_BASE = (process.env.OPENAI_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, "");
const API_KEY = process.env.OPENAI_API_KEY ?? "";
const MODEL = process.env.OPENAI_MODEL ?? "deepseek-chat";

const SUMMARY_PROMPT =
  "summarize into SKILL.md format: Markdown with sections ## Context, ## Decisions, ## State, ## Next Steps. " +
  "Preserve names, ids, file paths and commands verbatim. No preamble, no filler.";

type Msg = { role: string; content: string };

async function readFileOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

// ponytail: corrupt history.json throws instead of returning [] - never wipe user data on a parse error
async function readHistory(): Promise<Msg[]> {
  const raw = await readFileOrNull(HISTORY_FILE);
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : (parsed as { messages?: unknown })?.messages;
  if (!Array.isArray(list)) throw new Error(`${HISTORY_FILE}: expected an array or { "messages": [...] }`);
  return list.map((m) => ({ role: String(m?.role ?? "user"), content: String(m?.content ?? "") }));
}

async function atomicWrite(file: string, data: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file); // rename is atomic: a crash mid-write cannot truncate history.json
}

async function summarize(msgs: Msg[]): Promise<string> {
  if (!API_KEY) throw new Error("OPENAI_API_KEY is not set");
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: SUMMARY_PROMPT },
        { role: "user", content: msgs.map((m) => `${m.role}: ${m.content}`).join("\n\n") },
      ],
    }),
  });
  if (!res.ok) throw new Error(`chat/completions ${res.status} (${API_BASE}): ${(await res.text()).slice(0, 400)}`);
  // gateways differ: some answer { choices }, some { data: { choices } } and append an SSE tail
  const raw = (await res.text()).replace(/\s*data:\s*\[DONE\]\s*$/i, "");
  const body = JSON.parse(raw) as {
    choices?: { message?: { content?: string } }[];
    data?: { choices?: { message?: { content?: string } }[] };
  };
  const text = (body.choices ?? body.data?.choices)?.[0]?.message?.content?.trim();
  if (!text) throw new Error("no content in the chat/completions response");
  return text;
}

async function compact(targetPercent: number): Promise<string> {
  const msgs = await readHistory();
  if (!msgs.length) return "history empty: nothing to compact";
  const before = tokens(JSON.stringify(msgs));
  const budget = Math.max(1, Math.floor((before * targetPercent) / 100));
  if (before <= budget) {
    return `already within target: ${before} tokens <= ${budget} budget (target ${targetPercent}%), nothing compacted`;
  }

  // every message is fed to the summarizer, so none can be dropped; the newest ones are ALSO kept verbatim
  // ponytail: the tail is a verbatim echo of already-summarized messages (duplication, never loss)
  const summary = await summarize(msgs);
  const summaryTokens = tokens(summary);
  const tailBudget = Math.max(0, budget - summaryTokens);
  const tail: Msg[] = [];
  let tailTokens = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const t = tokens(JSON.stringify(msgs[i]));
    if (tailTokens + t > tailBudget) break;
    tail.unshift(msgs[i]);
    tailTokens += t;
  }
  const build = (): Msg[] => [{ role: "user", content: `[compacted summary]\n\n${summary}` }, ...tail];
  let kept = build();
  let after = tokens(JSON.stringify(kept));
  while (tail.length && after > budget) {
    tail.shift(); // still covered by the summary, so this drops nothing
    kept = build();
    after = tokens(JSON.stringify(kept));
  }

  const raw = await readFileOrNull(HISTORY_FILE);
  if (raw !== null) await atomicWrite(`${HISTORY_FILE}.bak`, raw);
  await atomicWrite(HISTORY_FILE, JSON.stringify(kept, null, 2));
  const overshoot = after > budget ? ` WARNING: still over budget, summary alone is ${summaryTokens} tokens` : "";
  return [
    `compacted ${before} -> ${after} tokens (${((after / before) * 100).toFixed(1)}% of original, target ${targetPercent}%)${overshoot}`,
    `messages: ${msgs.length} -> ${kept.length} (${msgs.length} summarized to ${summaryTokens} tokens, ${tail.length} kept verbatim)`,
    `file: ${HISTORY_FILE}`,
    `backup: ${HISTORY_FILE}.bak`,
  ].join("\n");
}

const skillPath = (p?: string) => (p ? path.resolve(ROOT, p) : DEFAULT_SKILL);

type Reply = { content: { type: "text"; text: string }[]; isError?: boolean };

const wrap =
  (fn: (...args: any[]) => Promise<string>) =>
  async (...args: any[]): Promise<Reply> => {
    try {
      return { content: [{ type: "text", text: await fn(...args) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  };

const server = new McpServer({ name: "vcm-mcp", version: "1.0.0" });

server.registerTool(
  "get_token_status",
  {
    title: "Get token status",
    description: "Token usage of .vcm/history.json against the context window (js-tiktoken, gpt-4o o200k_base).",
    inputSchema: {},
  },
  wrap(async () => {
    const msgs = await readHistory();
    const used = tokens(JSON.stringify(msgs));
    const projected = Math.floor(used * 0.4);
    return [
      `history: ${msgs.length} messages (${HISTORY_FILE})`,
      `tokens: ${used} / ${CONTEXT_WINDOW} window (${((used / CONTEXT_WINDOW) * 100).toFixed(1)}% used, ${CONTEXT_WINDOW - used} left)`,
      `compact_memory(40) -> ~${projected} tokens (saves ~${used - projected})`,
    ].join("\n");
  }),
);

server.registerTool(
  "compact_memory",
  {
    title: "Compact memory",
    description:
      "Summarize the oldest chat history in .vcm/history.json into SKILL.md format (via an OpenAI-compatible endpoint) until it fits target_percent% of its current token size.",
    inputSchema: {
      target_percent: z.number().int().min(5).max(90).default(40).describe("result size as % of original tokens, default 40"),
    },
  },
  wrap(async ({ target_percent }: { target_percent: number }) => compact(target_percent)),
);

server.registerTool(
  "read_skill_md",
  {
    title: "Read SKILL.md",
    description: "Read a SKILL.md file (default: SKILL.md in the project root).",
    inputSchema: { path: z.string().optional().describe("relative or absolute path, default SKILL.md") },
  },
  wrap(async ({ path: p }: { path?: string }) => {
    const file = skillPath(p);
    const raw = await readFileOrNull(file);
    if (raw === null) return `not found: ${file}`;
    return `${file} (${tokens(raw)} tokens)\n\n${raw}`;
  }),
);

server.registerTool(
  "write_skill_md",
  {
    title: "Write SKILL.md",
    description: "Atomically write a SKILL.md file (default: SKILL.md in the project root).",
    inputSchema: {
      content: z.string().describe("full file content"),
      path: z.string().optional().describe("relative or absolute path, default SKILL.md"),
    },
  },
  wrap(async ({ content, path: p }: { content: string; path?: string }) => {
    const file = skillPath(p);
    await atomicWrite(file, content);
    return `wrote ${file} (${content.length} chars, ${tokens(content)} tokens)`;
  }),
);

await server.connect(new StdioServerTransport());

