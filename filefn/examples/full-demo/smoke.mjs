#!/usr/bin/env node

const apiBase = process.env.FILEFN_DEMO_BASE_URL || "http://localhost:3001/filefn";
const clientBase = process.env.FILEFN_DEMO_CLIENT_BASE || "http://localhost:5173";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function parseEnvelope(response, label) {
  const body = await response.json();
  if (!response.ok || !body.ok) {
    throw new Error(`${label} failed: ${JSON.stringify(body)}`);
  }
  return body.data;
}

function resolveDownloadUrl(rawUrl) {
  if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
    return rawUrl;
  }
  if (rawUrl.startsWith("/proxy/")) {
    return `${apiBase}${rawUrl}`;
  }
  return new URL(rawUrl, `${apiBase}/`).toString();
}

async function main() {
  const bytes = Buffer.from(`filefn-demo-smoke-${Date.now()}`, "utf-8");

  const initData = await parseEnvelope(
    await fetch(`${apiBase}/upload/init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        policy: "public-image",
        fileName: "smoke.png",
        size: bytes.length,
        mimeType: "image/png",
      }),
    }),
    "upload init",
  );

  assert(initData.uploadMode === "proxy", `Expected proxy mode, got ${initData.uploadMode}`);

  await parseEnvelope(
    await fetch(`${apiBase}/upload/${initData.uploadSessionId}/parts/1`, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.length),
      },
      body: bytes,
    }),
    "upload part",
  );

  const completeData = await parseEnvelope(
    await fetch(`${apiBase}/upload/${initData.uploadSessionId}/complete`, { method: "POST" }),
    "upload complete",
  );

  const listBeforeDelete = await parseEnvelope(
    await fetch(`${apiBase}/?limit=50`),
    "list files",
  );

  const createdFile = listBeforeDelete.files.find((f) => f.fileId === completeData.fileId);
  assert(Boolean(createdFile), "Uploaded file was not returned by list");

  const downloadData = await parseEnvelope(
    await fetch(`${apiBase}/${completeData.fileId}/download`),
    "download descriptor",
  );
  const downloadUrl = resolveDownloadUrl(downloadData.url);
  const downloadResponse = await fetch(downloadUrl);
  assert(downloadResponse.ok, `download failed with HTTP ${downloadResponse.status}`);
  const downloadedBytes = Buffer.from(await downloadResponse.arrayBuffer());
  assert(downloadedBytes.equals(bytes), "downloaded bytes do not match uploaded bytes");

  await parseEnvelope(
    await fetch(`${apiBase}/${completeData.fileId}`, { method: "DELETE" }),
    "delete file",
  );

  const listAfterDelete = await parseEnvelope(
    await fetch(`${apiBase}/?limit=50`),
    "list after delete",
  );
  const stillPresent = listAfterDelete.files.some((f) => f.fileId === completeData.fileId);
  assert(!stillPresent, "Deleted file is still present in listing");

  const clientResponse = await fetch(clientBase);
  assert(clientResponse.ok, `demo client check failed with HTTP ${clientResponse.status}`);

  console.log("Demo smoke passed: upload/list/download/delete all succeeded.");
  console.log(`API base: ${apiBase}`);
  console.log(`Client base: ${clientBase}`);
}

main().catch((error) => {
  console.error("Demo smoke failed.");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
