import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  lstatSync,
  writeFileSync,
  fsyncSync,
  unlinkSync,
  linkSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DockerEngineError, type DockerEngine } from "./docker-engine.js";
import { ProcessGroupUncertainError } from "./executor/owned-shell.js";

export interface DockerReceiptDecision {
  id: string;
  fingerprint: string;
  owner: string;
  operatorId: string;
  stoppedOwner: true;
}
export interface DockerCleanupReceipt {
  version: 1;
  id: string;
  fingerprint: string;
  owner: string;
  operatorId: string;
  stoppedOwner: true;
  containerRemoved: true;
  executionOutcome: "unknown";
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
function fail(): never {
  throw new Error("Docker receipt requires explicit repair");
}
function directory(root: string, id: string) {
  if (!uuid.test(id)) fail();
  const path = join(root, id),
    stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) fail();
  return path;
}
function read(path: string): {
  value: Record<string, unknown>;
  fingerprint: string;
} {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 16384 ||
      stat.mode & 0o077
    )
      fail();
    const buffer = Buffer.alloc(16385);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, count);
    if (bytes.length > 16384) fail();
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail();
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    return {
      value: value as Record<string, unknown>,
      fingerprint: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    closeSync(fd);
  }
}
function sync(path: string) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function receipt(root: string, context: string, id: string) {
  const path = directory(root, id),
    { value, fingerprint } = read(join(path, "receipt.json"));
  if (
    value.version !== 2 ||
    value.mode !== "job" ||
    value.id !== id ||
    value.name !== `cifn-${id}` ||
    value.context !== context ||
    typeof value.owner !== "string" ||
    !value.owner ||
    value.owner.length > 1024 ||
    typeof value.daemonId !== "string" ||
    !value.daemonId ||
    value.daemonId.length > 512 ||
    typeof value.containerId !== "string" ||
    (value.containerId !== "" && !hash.test(value.containerId)) ||
    typeof value.execId !== "string" ||
    (value.execId !== "" && !hash.test(value.execId)) ||
    ![
      "creating",
      "created",
      "ready",
      "executing",
      "closing",
      "cleanup-uncertain",
    ].includes(String(value.phase))
  )
    fail();
  return {
    path,
    fingerprint,
    id,
    owner: value.owner,
    context,
    daemonId: value.daemonId,
    containerId: value.containerId,
    execId: value.execId,
    phase: String(value.phase),
  };
}
/** Exact-ID inspection only: no payload/environment, unbounded directory listing or daemon mutation. */
export function inspectDockerReceipt(
  root: string,
  context: string,
  id: string,
) {
  const { path: _path, ...projection } = receipt(root, context, id);
  return projection;
}
function matchingTerminal(
  value: Record<string, unknown>,
  decision: DockerReceiptDecision,
): DockerCleanupReceipt {
  if (
    value.version !== 1 ||
    value.id !== decision.id ||
    value.fingerprint !== decision.fingerprint ||
    value.owner !== decision.owner ||
    value.operatorId !== decision.operatorId ||
    value.stoppedOwner !== true ||
    value.containerRemoved !== true ||
    value.executionOutcome !== "unknown"
  )
    fail();
  return {
    version: 1,
    id: decision.id,
    fingerprint: decision.fingerprint,
    owner: decision.owner,
    operatorId: decision.operatorId,
    stoppedOwner: true,
    containerRemoved: true,
    executionOutcome: "unknown",
  };
}
/** Trusted host attestation. The durable lock fences cooperating cleanup callers, not an old live execution owner. */
export async function cleanupDockerReceipt(
  root: string,
  context: string,
  decision: DockerReceiptDecision,
  connect: () => Promise<{ engine: DockerEngine; daemonId: string }>,
): Promise<DockerCleanupReceipt> {
  if (
    !decision ||
    !hash.test(decision.fingerprint) ||
    typeof decision.owner !== "string" ||
    !decision.owner ||
    decision.owner.length > 1024 ||
    typeof decision.operatorId !== "string" ||
    !/^[A-Za-z0-9_.:@-]{1,128}$/.test(decision.operatorId) ||
    decision.stoppedOwner !== true
  )
    fail();
  const initial = receipt(root, context, decision.id);
  if (
    initial.fingerprint !== decision.fingerprint ||
    initial.owner !== decision.owner ||
    !initial.containerId
  )
    fail();
  const terminal = join(initial.path, "cleanup.json"),
    lock = join(initial.path, "cleanup.lock");
  // Only a complete terminal receipt authorizes idempotent readback; no stale lock is stolen.
  try {
    return matchingTerminal(read(terminal).value, decision);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const fd = openSync(
    lock,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  let uncertain = false;
  try {
    writeFileSync(
      fd,
      JSON.stringify({
        version: 1,
        id: decision.id,
        fingerprint: decision.fingerprint,
        owner: decision.owner,
        operatorId: decision.operatorId,
        stoppedOwner: true,
      }),
    );
    fsyncSync(fd);
    sync(initial.path);
    const current = receipt(root, context, decision.id);
    if (
      current.fingerprint !== decision.fingerprint ||
      current.owner !== decision.owner
    )
      fail();
    // From here an interrupted request may have changed daemon state: retain the exclusive lock.
    uncertain = true;
    const { engine, daemonId } = await connect();
    if (daemonId !== current.daemonId) throw new ProcessGroupUncertainError();
    const info = (await engine.json("GET", "/info")) as { ID?: unknown };
    if (info?.ID !== daemonId) throw new ProcessGroupUncertainError();
    let exists = true;
    try {
      const state = (await engine.json(
        "GET",
        `/containers/${current.containerId}/json`,
      )) as { Id?: unknown; Config?: { Labels?: Record<string, unknown> } };
      if (
        state?.Id !== current.containerId ||
        state.Config?.Labels?.["io.21n.cifn.owner"] !== current.id
      )
        throw new ProcessGroupUncertainError();
    } catch (error) {
      if (error instanceof DockerEngineError && error.status === 404)
        exists = false;
      else throw error;
    }
    if (exists)
      await engine.json("DELETE", `/containers/${current.containerId}?force=1`);
    for (const identity of [current.containerId, `cifn-${current.id}`]) {
      try {
        await engine.json("GET", `/containers/${identity}/json`);
        throw new ProcessGroupUncertainError();
      } catch (error) {
        if (!(error instanceof DockerEngineError && error.status === 404))
          throw error;
      }
    }
    // Revalidate receipt after I/O. A writer violating stopped-owner attestation cannot receive a successful decision.
    if (
      receipt(root, context, decision.id).fingerprint !== decision.fingerprint
    )
      throw new ProcessGroupUncertainError();
    const result: DockerCleanupReceipt = {
      version: 1,
      id: decision.id,
      fingerprint: decision.fingerprint,
      owner: decision.owner,
      operatorId: decision.operatorId,
      stoppedOwner: true,
      containerRemoved: true,
      executionOutcome: "unknown",
    };
    const temporary = join(current.path, `cleanup-${randomUUID()}.tmp`),
      output = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(output, JSON.stringify(result));
      fsyncSync(output);
    } finally {
      closeSync(output);
    }
    linkSync(temporary, terminal);
    unlinkSync(temporary);
    sync(current.path);
    uncertain = false;
    return result;
  } catch {
    throw new ProcessGroupUncertainError();
  } finally {
    closeSync(fd);
    if (!uncertain) {
      unlinkSync(lock);
      sync(initial.path);
    }
  }
}
