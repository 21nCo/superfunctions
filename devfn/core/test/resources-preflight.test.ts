import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createComposeEnvironment, selectedComposeEndpointReferences } from "@devfn/compose";
import { validateDevFnConfig, type DevFnConfig } from "@devfn/config";
import { FilePortRegistry } from "@devfn/ports";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPlan, DevFnOrchestrator, planResources, resolveEndpointTemplates } from "../src/index.js";
import { sameServiceNames } from "./resource-fixtures.js";

/**
 * Effective networks by Compose project and service. They stand in for
 * `docker compose config`, so these preflight checks need no Docker; the
 * references a service interpolates still come from its Compose source.
 */
const effective = vi.hoisted(() => ({ networks: {} as Record<string, string[]>, names: {} as Record<string, { networks: Record<string, string[]>; overrides: string[] }> }));

vi.mock("@devfn/compose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@devfn/compose")>();
  return {
    ...actual,
    effectiveComposeServiceNetworks: async (...[spec, root, , environment, deadline, references, dnsNames]: Parameters<typeof actual.effectiveComposeServiceNetworks>) => {
      for (const name of await actual.selectedComposeEndpointReferences(spec, root, environment, deadline)) references?.add(name);
      const names = effective.names[`${spec.projectName ?? "devfn"}/${spec.service}`];
      if (dnsNames && names) Object.assign(dnsNames, names);
      return effective.networks[`${spec.projectName ?? "devfn"}/${spec.service}`] ?? [];
    },
  };
});

afterEach(() => {
  effective.networks = {};
  effective.names = {};
  vi.restoreAllMocks();
});

/** Runs a check as Linux, which has no implicit container host gateway, and as macOS. */
async function onEachPlatform(check: (platform: NodeJS.Platform) => Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  for (const platform of ["linux", "darwin"] as const) {
    Object.defineProperty(process, "platform", { ...original, value: platform });
    try { await check(platform); } finally { Object.defineProperty(process, "platform", original); }
  }
}

/** Expects up to fail with an error before any lease, lifecycle state or start. */
async function expectRejectedBeforeState(config: DevFnConfig, root: string, error: Record<string, unknown>, label?: string): Promise<void> {
  const stateDir = path.join(root, "state");
  // A regression stops at reservation instead of starting anything.
  const reserve = vi.spyOn(FilePortRegistry.prototype, "reserve").mockRejectedValue(new Error("reached port reservation"));
  await expect(new DevFnOrchestrator().up({ config, root, stateDir }), label).rejects.toMatchObject(error);
  expect(reserve, label).not.toHaveBeenCalled();
  await expect(access(stateDir), label).rejects.toMatchObject({ code: "ENOENT" });
  reserve.mockRestore();
}

/** Expects up to pass preflight and stop at port reservation. */
async function expectReservation(config: DevFnConfig, root: string): Promise<void> {
  vi.spyOn(FilePortRegistry.prototype, "reserve").mockRejectedValue(new Error("stopped at port reservation"));
  await expect(new DevFnOrchestrator().up({ config, root, stateDir: path.join(root, "state") })).rejects.toThrow("stopped at port reservation");
}

async function withRoot(prefix: string, run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

describe("resource container hosts", () => {
  it("rejects a loopback-named Compose provider before creating lifecycle state", async () => {
    await withRoot("devfn-resource-loopback-provider-", async (root) => {
      await writeFile(path.join(root, "compose.yaml"), "services:\n  localhost:\n    image: busybox\n  worker:\n    image: busybox\n");
      const config = validateDevFnConfig({ version: 1, project: { id: "loopback-provider" }, ports: { redis: {} },
        services: { redis: { adapter: "compose", service: "localhost", ports: { redis: 6379 } }, worker: { adapter: "compose", service: "worker", resources: ["cache"] } },
        resources: { cache: { kind: "cache", defaultTarget: "local", targets: { local: { node: "redis", port: "redis", scheme: "redis" } } } },
        profiles: { default: { services: ["worker"] } } });
      await onEachPlatform(async (platform) => {
        effective.networks = { "devfn/localhost": ["shared"], "devfn/worker": ["shared"] };
        await expectRejectedBeforeState(config, root, { code: "DEVFN_RESOURCE_INVALID", message: expect.stringContaining("Compose service localhost, a loopback name") }, platform);
      });
    });
  }, 60_000);
});

describe("resource collisions on effective Compose networks", () => {
  it("rejects same-named providers of two projects on one network before creating lifecycle state", async () => {
    await withRoot("devfn-resource-same-names-", async (root) => {
      await writeFile(path.join(root, "compose.yaml"), "services:\n  redis:\n    image: busybox\n  wa:\n    image: busybox\n  wb:\n    image: busybox\n");
      const config = sameServiceNames("cache");
      // Provisional networks are per project; only the effective shared network joins them.
      await onEachPlatform(async (platform) => {
        effective.networks = { "alpha/redis": ["ext"], "beta/redis": ["ext"], "alpha/wa": ["ext"], "beta/wb": ["ext"] };
        await expectRejectedBeforeState(config, root, { code: "DEVFN_RESOURCE_INVALID", message: expect.stringContaining("which selects provider ra, but its endpoint redis:6379 also names rb") }, platform);
      });
      effective.networks = { "alpha/redis": ["a"], "alpha/wa": ["a"], "beta/redis": ["b"], "beta/wb": ["b"] };
      await expectReservation(config, root);
    });
  }, 60_000);

  it("rejects a consumer whose provider name also reaches another selected service before creating lifecycle state", async () => {
    await withRoot("devfn-resource-ambiguous-name-", async (root) => {
      await writeFile(path.join(root, "compose.yaml"), "services:\n  redis:\n    image: busybox\n  wa:\n    image: busybox\n");
      const config = sameServiceNames("database", { single: true });
      await onEachPlatform(async (platform) => {
        effective.networks = { "alpha/redis": ["ext"], "beta/redis": ["ext"], "alpha/wa": ["ext"] };
        await expectRejectedBeforeState(config, root, { code: "DEVFN_RESOURCE_INVALID", message: expect.stringContaining("which selects provider ra, but its endpoint redis:6379 also names rb") }, platform);
      });
      effective.networks = { "alpha/redis": ["a"], "alpha/wa": ["a"], "beta/redis": ["b"] };
      await expectReservation(config, root);
    });
  }, 60_000);

  it("rejects a remote alias of a Compose provider on a shared network before creating lifecycle state", async () => {
    // A Compose redis provider beside a remote cache written as its service name, used by a worker.
    const aliased = validateDevFnConfig({ version: 1, project: { id: "resource-effective-networks" }, ports: { redis: {} },
      services: {
        redis: { adapter: "compose", service: "redis", ports: { redis: 6379 } },
        worker: { adapter: "compose", service: "worker", resources: ["sessions"] },
      },
      resources: {
        cache: { kind: "cache", defaultTarget: "local", namespace: { base: "data" }, targets: { local: { node: "redis", port: "redis" } } },
        sessions: { kind: "cache", defaultTarget: "dev", namespace: { base: "data" }, targets: { dev: { url: "redis://redis:6379" } } },
      },
      profiles: { default: { services: ["worker"], resources: { cache: "local" } } } });
    await withRoot("devfn-resource-networks-", async (root) => {
      await writeFile(path.join(root, "compose.yaml"), "services:\n  redis:\n    image: busybox\n  worker:\n    image: busybox\n");
      await onEachPlatform(async (platform) => {
        effective.networks = { "devfn/redis": ["shared"], "devfn/worker": ["shared"] };
        await expectRejectedBeforeState(aliased, root, { code: "DEVFN_RESOURCE_INVALID", message: expect.stringContaining("share namespace data:") }, platform);
      });
      // Provisional networks put both on one default network; only effective ones decide.
      effective.networks = { "devfn/redis": ["one"], "devfn/worker": ["two"] };
      await expectReservation(aliased, root);
    });
  }, 60_000);

  it("rejects a selected service whose network alias is the provider's name before creating lifecycle state", async () => {
    const competing = validateDevFnConfig({ version: 1, project: { id: "resource-network-aliases" }, ports: { redis: {} },
      services: {
        redis: { adapter: "compose", service: "redis", ports: { redis: 6379 } },
        other: { adapter: "compose", service: "other" },
        worker: { adapter: "compose", service: "worker", resources: ["cache"] },
      },
      resources: { cache: { kind: "cache", defaultTarget: "local", targets: { local: { node: "redis", port: "redis" } } } },
      profiles: { default: { services: ["worker", "other"] } } });
    await withRoot("devfn-resource-aliases-", async (root) => {
      await writeFile(path.join(root, "compose.yaml"), "services:\n  redis:\n    image: busybox\n  other:\n    image: busybox\n  worker:\n    image: busybox\n");
      effective.networks = { "devfn/redis": ["shared"], "devfn/other": ["shared", "private"], "devfn/worker": ["shared"] };
      await onEachPlatform(async (platform) => {
        effective.names = { "devfn/other": { networks: { shared: ["redis"] }, overrides: [] } };
        await expectRejectedBeforeState(competing, root, { code: "DEVFN_RESOURCE_INVALID", message: expect.stringContaining("which selects provider redis, but its endpoint redis:6379 also names other") }, platform);
      });
      // The same alias on a network the worker does not join reaches no consumer.
      effective.names = { "devfn/other": { networks: { private: ["redis"] }, overrides: [] } };
      await expectReservation(competing, root);
    });
  }, 60_000);
});

describe("resource references only Compose interpolates", () => {
  // A worker that consumes a Compose provider's resource interpolates its values only in its Compose file.
  const composeOnly = (environment: string) => ({
    file: `services:\n  redis:\n    image: busybox\n  worker:\n    image: busybox\n    environment:\n${environment}`,
    config: validateDevFnConfig({ version: 1, project: { id: "resource-compose-missing" }, ports: { redis: {} },
      services: {
        redis: { adapter: "compose", service: "redis", ports: { redis: 6379 } },
        worker: { adapter: "compose", service: "worker", resources: ["cache"] },
      },
      resources: { cache: { kind: "cache", defaultTarget: "local", targets: { local: { node: "redis", port: "redis" } } } },
      profiles: { default: { services: ["worker"] } } }),
  });

  it("rejects a resource value the service does not receive before creating lifecycle state", async () => {
    await withRoot("devfn-resource-compose-missing-", async (root) => {
      await onEachPlatform(async (platform) => {
        effective.networks = { "devfn/redis": ["shared"], "devfn/worker": ["shared"] };
        // A typo, and the URL of a target that declares no scheme.
        for (const name of ["DEVFN_RESOURCE_CACHE_TYPO", "DEVFN_RESOURCE_CACHE_URL"]) {
          const fixture = composeOnly(`      VALUE: \${${name}}\n`);
          await writeFile(path.join(root, "compose.yaml"), fixture.file);
          await expectRejectedBeforeState(fixture.config, root, { code: "DEVFN_RUNTIME_INVALID", message: `services.worker.compose: missing reference ${name}.` }, `${platform} ${name}`);
        }
      });
    });
  }, 60_000);

  it("keeps Linux fail-closed for Compose consumers of host listeners", async () => {
    // The same worker consuming a native provider, which only a platform host gateway reaches.
    const hostProvider = validateDevFnConfig({ version: 1, project: { id: "resource-host-provider" }, ports: { redis: {} },
      processes: { redis: { adapter: "command", command: ["redis-server"], ports: ["redis"] } },
      services: { worker: { adapter: "compose", service: "worker", resources: ["cache"] } },
      resources: { cache: { kind: "cache", defaultTarget: "local", targets: { local: { node: "redis", port: "redis" } } } },
      profiles: { default: { services: ["worker"] } } });
    await withRoot("devfn-resource-host-provider-", async (root) => {
      await writeFile(path.join(root, "compose.yaml"), "services:\n  worker:\n    image: busybox\n    environment:\n      VALUE: ${DEVFN_RESOURCE_CACHE_ENDPOINT}\n");
      await onEachPlatform(async (platform) => {
        if (platform === "linux") {
          await expectRejectedBeforeState(hostProvider, root, { code: "DEVFN_RESOURCE_INVALID", message: expect.stringContaining("cannot reach on this platform without a container host gateway") }, platform);
        } else {
          await expectReservation(hostProvider, root);
          vi.restoreAllMocks();
        }
      });
    });
  }, 60_000);

  it("accepts values the service receives and Compose fallbacks for values it does not", async () => {
    await withRoot("devfn-resource-compose-available-", async (root) => {
      const fixture = composeOnly("      ENDPOINT: ${DEVFN_RESOURCE_CACHE_ENDPOINT}\n      URL: ${DEVFN_RESOURCE_CACHE_URL:-redis://fallback:6379}\n");
      await writeFile(path.join(root, "compose.yaml"), fixture.file);
      const lifecycle = createPlan(fixture.config);
      const ports = { redis: 4107 };
      const composeNetworks = { redis: ["shared"], worker: ["shared"] };
      const resolve = (composeReferences: Set<string>) => resolveEndpointTemplates({ config: fixture.config, plan: lifecycle, ownerId: "owner-a", ports,
        composeNetworks, composeReferences: { worker: composeReferences },
        resources: planResources({ config: fixture.config, plan: lifecycle, ownerId: "owner-a", ports, platform: "linux", composeNetworks }) });
      const provisional = resolve(new Set());
      const spec = fixture.config.services!.worker;
      const environment = createComposeEnvironment({ ...spec, env: provisional.nodes.worker.environment }, provisional.nodes.worker.environment);
      const references = await selectedComposeEndpointReferences({ ...spec, env: provisional.nodes.worker.environment }, root, environment);
      expect([...references]).toEqual(["DEVFN_RESOURCE_CACHE_ENDPOINT"]);
      expect(resolve(references).nodes.worker.environment.DEVFN_RESOURCE_CACHE_ENDPOINT).toBe("redis:6379");
    });
  }, 60_000);

  it("rejects an unreachable resource value before creating lifecycle state", async () => {
    await withRoot("devfn-resource-compose-reference-", async (root) => {
      await writeFile(path.join(root, "compose.yaml"), "services:\n  worker:\n    image: busybox\n    environment:\n      DEV_URL: ${DEVFN_RESOURCE_DEV_URL}\n");
      const config = (resources?: string[]) => validateDevFnConfig({ version: 1, project: { id: "resource-compose-reference" },
        services: { worker: { adapter: "compose", service: "worker", ...(resources ? { resources } : {}) } },
        resources: { dev: { kind: "service", defaultTarget: "proxy", targets: { proxy: { url: "http://api.localhost:1355" } } } },
        profiles: { default: { services: ["worker"], resources: { dev: "proxy" } } } });
      await onEachPlatform(async (platform) => {
        await expectRejectedBeforeState(config(["dev"]), root, { code: "DEVFN_RESOURCE_INVALID", message: expect.stringContaining("Resource dev target proxy uses loopback name api.localhost") }, platform);
        // A service that does not consume the resource receives none of its values.
        await expectRejectedBeforeState(config(), root, { code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("Compose service worker does not consume resource dev") }, platform);
      });
    });
  }, 60_000);
});
