// Lists the entries of a .mcpb (zip) without extra deps: reads the central directory.
import { readFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const file = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "..", "vcm-mcp.mcpb"));
const buf = readFileSync(file);
const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
const count = buf.readUInt16LE(eocd + 10);
let off = buf.readUInt32LE(eocd + 16);
const names = [];
for (let i = 0; i < count; i++) {
  const method = buf.readUInt16LE(off + 10);
  const nameLen = buf.readUInt16LE(off + 28);
  const extraLen = buf.readUInt16LE(off + 30);
  const commentLen = buf.readUInt16LE(off + 32);
  const compSize = buf.readUInt32LE(off + 20);
  const name = buf.subarray(off + 46, off + 46 + nameLen).toString();
  const local = buf.readUInt32LE(off + 42);
  const localNameLen = buf.readUInt16LE(local + 26);
  const localExtraLen = buf.readUInt16LE(local + 28);
  const dataStart = local + 30 + localNameLen + localExtraLen;
  const raw = buf.subarray(dataStart, dataStart + compSize);
  const content = method === 0 ? raw : zlib.inflateRawSync(raw);
  if (!name.startsWith("node_modules/")) names.push(`${name} (${content.length} B)`);
  off += 46 + nameLen + extraLen + commentLen;
}
console.log(names.join("\n"));
console.log(`entries: ${count}`);
