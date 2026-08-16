import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { readJsonBody } from "../server/read-json-body.mjs";

test("JSON body preserves Chinese text split across UTF-8 chunks", async () => {
  const request = new PassThrough();
  const parsed = readJsonBody(request);
  const bytes = Buffer.from(JSON.stringify({ message: "中文课程" }), "utf8");
  const split = bytes.indexOf(Buffer.from("中", "utf8")) + 1;
  request.write(bytes.subarray(0, split));
  request.end(bytes.subarray(split));
  assert.deepEqual(await parsed, { message: "中文课程" });
});

test("JSON body byte limit counts UTF-8 bytes and aborts oversized input", async () => {
  const request = new PassThrough();
  const parsed = readJsonBody(request, { maxBytes: 5 });
  request.end(Buffer.from("中文", "utf8"));
  await assert.rejects(parsed, (error) => error.statusCode === 413 && /too large/i.test(error.message));
  assert.equal(request.destroyed, true);
});

test("JSON body rejects malformed UTF-8 before JSON parsing", async () => {
  const request = new PassThrough();
  const parsed = readJsonBody(request);
  request.end(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]));
  await assert.rejects(parsed, (error) => error.statusCode === 400 && /UTF-8/.test(error.message));
});

test("public JSON bodies can reject already-decoded replacement characters", async () => {
  const request = new PassThrough();
  const parsed = readJsonBody(request, { rejectReplacementCharacters: true });
  request.end(Buffer.from(JSON.stringify({ content: "damaged \uFFFD text" }), "utf8"));
  await assert.rejects(parsed, (error) => error.statusCode === 400 && /U\+FFFD/.test(error.message));
});
