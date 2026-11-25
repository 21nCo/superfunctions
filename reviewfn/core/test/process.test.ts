import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { runProcessGroup } from "../src/index.js";

// A real child writes the bytes of one multi-byte character in separate writes with a pause between them, so the
// parent receives them in separate pipe chunks. Per-chunk decoding would turn each half into U+FFFD.
const splitWriter = (fd: 1 | 2) => [
  "const bytes = Buffer.from('a\\u2014\\u{1F600}b', 'utf8');",
  "const parts = [bytes.subarray(0, 2), bytes.subarray(2, 3), bytes.subarray(3, 5), bytes.subarray(5)];",
  "const fs = require('node:fs');",
  `(async () => { for (const part of parts) { fs.writeSync(${fd}, part); await new Promise(r => setTimeout(r, 60)); } })();`,
].join("\n");

const options = { cwd: tmpdir(), env: { PATH: process.env.PATH }, timeoutMs: 10_000, maxOutputBytes: 1024 };

describe("runProcessGroup", () => {
  it("keeps multi-byte UTF-8 characters intact when they are split across stdout chunks", async () => {
    const result = await runProcessGroup(process.execPath, ["-e", splitWriter(1)], options);
    expect(result).toMatchObject({ code: 0, timedOut: false, canceled: false });
    expect(result.stdout).toBe("a—\u{1F600}b");
    expect(result.stdout).not.toContain("�");
  }, 15_000);

  it("keeps multi-byte UTF-8 characters intact when they are split across stderr chunks", async () => {
    const result = await runProcessGroup(process.execPath, ["-e", splitWriter(2)], options);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("a—\u{1F600}b");
  }, 15_000);

  it("still enforces the byte-based output cap", async () => {
    const result = await runProcessGroup(process.execPath, ["-e", "process.stdout.write('\\u2014'.repeat(400)); setTimeout(() => {}, 5000);"], { ...options, maxOutputBytes: 600 });
    expect(result.timedOut).toBe(true);
    expect(result.stdout).not.toContain("�");
  }, 15_000);

  it("reports the byte length of every stdout and stderr chunk to onOutput", async () => {
    const seen: number[] = [];
    const result = await runProcessGroup(process.execPath, ["-e", splitWriter(1)], { ...options, onOutput: bytes => seen.push(bytes) });
    expect(result.code).toBe(0);
    expect(seen.reduce((sum, bytes) => sum + bytes, 0)).toBe(Buffer.byteLength("a\u2014\u{1F600}b"));
  }, 15_000);

  it("counts the raw bytes it kept before decoding, so a replaced character does not grow them", async () => {
    const result = await runProcessGroup(process.execPath, ["-e", "process.stdout.write(Buffer.from([0x61, 0xe2, 0x80, 0xff])); process.stderr.write('e');"], options);
    expect(result).toMatchObject({ code: 0, stdout: "a\uFFFD\uFFFD", stdoutBytes: 4, stderrBytes: 1 });
  }, 15_000);

  it("neither reports nor counts the chunk that crossed its cap", async () => {
    const seen: number[] = [];
    const child = "const fs = require('node:fs'); fs.writeSync(1, 'a'.repeat(100)); setTimeout(() => { fs.writeSync(1, 'b'.repeat(100)); setInterval(() => {}, 1000); }, 200);";
    const result = await runProcessGroup(process.execPath, ["-e", child], { ...options, maxOutputBytes: 150, onOutput: bytes => seen.push(bytes) });
    expect(result).toMatchObject({ timedOut: true, stdout: "a".repeat(100), stdoutBytes: 100, stderrBytes: 0 });
    expect(seen).toEqual([100]);
  }, 15_000);
});
