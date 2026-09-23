#!/usr/bin/env node
/**
 * 把学习指南针官方原件（35 份 PDF/DOC/DOCX）上传到 R2 guide-sources/ 前缀。
 *
 * 在生产服务器上执行（需要 R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET 环境变量）：
 *   node scripts/upload-guide-sources.mjs <原件根目录>
 *
 * 原件根目录指包含 Documents/ 子目录的交接包解压根目录；
 * 文件名 → 本地路径映射读取 content/learning-compass.generated.json 的 source_files。
 * 幂等：按内容 SHA-256 跳过已一致的对象；结束后逐个 HEAD 校验。
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const here = path.dirname(fileURLToPath(import.meta.url));
const mappingPath = path.join(here, "..", "content", "learning-compass.generated.json");
const prefix = process.env.GUIDE_SOURCES_PREFIX || "guide-sources";

const CONTENT_TYPES = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

const root = process.argv[2];
if (!root || !existsSync(root)) fail("usage: node scripts/upload-guide-sources.mjs <原件根目录（含 Documents/）>");
const env = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"];
for (const name of env) if (!process.env[name]) fail(`missing env ${name}`);

const client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});

const generated = JSON.parse(readFileSync(mappingPath, "utf8"));
const files = generated.source_files;
if (files.length !== 35) fail(`原件映射应为 35，实际 ${files.length}`);

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

let uploaded = 0;
let skipped = 0;
const problems = [];
for (const file of files) {
  const localPath = path.join(root, ...String(file.original_file).split("/"));
  if (!existsSync(localPath)) {
    problems.push(`MISSING ${file.id}: ${localPath}`);
    continue;
  }
  const key = `${prefix}/${file.file_name}`;
  const contentType = CONTENT_TYPES[file.file_type];
  if (!contentType) {
    problems.push(`UNKNOWN_TYPE ${file.id}: ${file.file_type}`);
    continue;
  }
  const body = readFileSync(localPath);
  const localHash = sha256(body);
  let remoteMatches = false;
  try {
    const existing = await client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
    const chunks = [];
    for await (const chunk of existing.Body) chunks.push(chunk);
    remoteMatches = sha256(Buffer.concat(chunks)) === localHash;
  } catch {
    remoteMatches = false;
  }
  if (remoteMatches) {
    skipped += 1;
    console.log(`skip  ${file.id} ${file.file_name}`);
    continue;
  }
  await client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    ContentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(file.file_name)}`,
    CacheControl: "public, max-age=86400, stale-while-revalidate=604800",
  }));
  uploaded += 1;
  console.log(`put   ${file.id} ${file.file_name} (${Math.round(body.length / 1024)} KB)`);
}

console.log(`done: uploaded=${uploaded} skipped=${skipped} problems=${problems.length}`);
for (const problem of problems) console.error(problem);
if (problems.length) process.exit(2);
