import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { validateDevFnConfig, type DevFnConfig } from "@devfn/config";
import { describe, expect, it } from "vitest";

import { createPlan, DevFnOrchestrator, planResources, receiptPath, resolveEndpointTemplates, type ResourcePlan } from "../src/index.js";

const PORTS = { api: 4101, reports: 4102, web: 4103, admin: 4104, pg: 4105, kafka: 4106, redis: 4107, objects: 4108 };

/** An application-neutral topology: two clients, two backends and selectable data targets. */
function topology(): Record<string, unknown> {
  return {
    version: 1, project: { id: "topology" },
    ports: { api: {}, reports: {}, web: {}, admin: {}, pg: {}, kafka: {}, redis: {}, objects: {} },
    processes: {
      "api-server": { adapter: "command", command: ["node", "api.mjs"], ports: ["api"], resources: ["db", "events", "cache"],
        envAllowlist: ["DB_PASSWORD"], secretEnv: ["DB_PASSWORD"] },
      "reports-server": { adapter: "command", command: ["node", "reports.mjs"], ports: ["reports"], resources: ["db"],
        envAllowlist: ["DB_PASSWORD"], secretEnv: ["DB_PASSWORD"] },
      web: { adapter: "command", command: ["node", "web.mjs", "{{env.DEVFN_RESOURCE_API_URL}}"], ports: ["web"], resources: ["api", "session"],
        env: { API_URL: "{{env.DEVFN_RESOURCE_API_URL}}" } },
      admin: { adapter: "command", command: ["node", "admin.mjs"], ports: ["admin"], resources: ["admin-api"],
        env: { API_URL: "{{env.DEVFN_RESOURCE_ADMIN_API_URL}}" } },
    },
    services: {
      postgres: { adapter: "compose", service: "postgres", ports: { pg: 5432 } },
      broker: { adapter: "compose", service: "broker", ports: { kafka: 9092 } },
      redis: { adapter: "compose", service: "redis", ports: { redis: 6379 } },
    },
    resources: {
      api: { kind: "service", defaultTarget: "local", targets: {
        local: { node: "api-server", port: "api", scheme: "http" },
        remote: { url: "https://api.example.test/v1" },
      } },
      "admin-api": { kind: "service", defaultTarget: "primary", targets: {
        primary: { node: "api-server", port: "api", scheme: "http" },
        reports: { node: "reports-server", port: "reports", scheme: "http" },
      } },
      db: { kind: "database", defaultTarget: "local", namespace: { level: "schema", database: "app" }, targets: {
        local: { node: "postgres", port: "pg", scheme: "postgres", secrets: { password: "DB_PASSWORD" } },
        remote: { url: "postgres://db.example.test:5432", secrets: { password: "DB_PASSWORD" } },
      } },
      events: { kind: "broker", defaultTarget: "local", topics: ["orders", "audit"], consumerGroup: "workers", targets: {
        local: { node: "broker", port: "kafka", scheme: "kafka" },
        remote: { url: "kafka://broker.example.test:9092" },
      } },
      cache: { kind: "cache", defaultTarget: "local", targets: { local: { node: "redis", port: "redis", scheme: "redis" } } },
      session: { kind: "browser", cookies: ["sid"], storageKeys: ["draft"] },
    },
    profiles: {
      default: { processes: ["web", "admin"] },
      "split-backends": { processes: ["web", "admin"], resources: { "admin-api": "reports" } },
      "remote-backend": { processes: ["web"], resources: { api: "remote" } },
      "remote-database": { processes: ["api-server"], resources: { db: "remote" } },
    },
  };
}

const config = (mutate: (value: any) => void = () => undefined): DevFnConfig => {
  const value = topology();
  mutate(value);
  return validateDevFnConfig(value);
};

function plan(value: DevFnConfig, profile?: string, options: Partial<Parameters<typeof planResources>[0]> = {}): ResourcePlan {
  const lifecycle = createPlan(value, profile);
  return planResources({ config: value, plan: lifecycle, ownerId: "owner-a", ports: PORTS, platform: "linux",
    composeNetworks: Object.fromEntries(lifecycle.nodes.filter((node) => node.kind === "service").map((node) => [node.name, ["shared"]])), ...options });
}

const nodes = (value: DevFnConfig, profile?: string) => createPlan(value, profile).nodes.map((node) => node.name).sort();
const value = (resources: ResourcePlan, name: string, key: string) => resources.resources[name].values[`DEVFN_RESOURCE_${key}`];

describe("resource topology fixtures", () => {
  it("serves two clients from one backend and starts only selected local providers", () => {
    const value_ = config();
    expect(nodes(value_)).toEqual(["admin", "api-server", "broker", "postgres", "redis", "web"]);
    const resources = plan(value_);
    expect(resources.resources.api).toMatchObject({ target: { name: "local", location: "local", selectedBy: "defaultTarget" }, provider: { node: "api-server", port: "api" }, consumers: ["web"] });
    expect(value(resources, "api", "API_URL")).toEqual({ value: "http://127.0.0.1:4101", source: "lease", field: "ports.api" });
    expect(value(resources, "admin-api", "ADMIN_API_URL")?.value).toBe(value(resources, "api", "API_URL")?.value);
    // Consumers start after the providers their selections name.
    expect(createPlan(value_).nodes.find((node) => node.name === "web")?.dependencies).toEqual(["api-server"]);
  });

  it("points clients at different backends when a profile selects another target", () => {
    const value_ = config();
    expect(nodes(value_, "split-backends")).toContain("reports-server");
    const resources = plan(value_, "split-backends");
    expect(resources.resources["admin-api"]).toMatchObject({ target: { name: "reports", selectedBy: "profile", field: "profiles.split-backends.resources.admin-api" } });
    expect(value(resources, "admin-api", "ADMIN_API_URL")?.value).toBe("http://127.0.0.1:4102");
    expect(value(resources, "api", "API_URL")?.value).toBe("http://127.0.0.1:4101");
  });

  it("runs a local client against a remote backend without starting the local backend", () => {
    const value_ = config();
    expect(nodes(value_, "remote-backend")).toEqual(["web"]);
    const resources = plan(value_, "remote-backend");
    expect(resources.resources.api).toMatchObject({ target: { name: "remote", location: "remote" }, remote: { url: "https://api.example.test/v1" } });
    expect(resources.resources.api.provider).toBeUndefined();
    expect(value(resources, "api", "API_URL")).toEqual({ value: "https://api.example.test/v1", source: "manifest", field: "resources.api.targets.remote.url" });
  });

  it("runs a local backend against an explicitly selected remote database with secret references only", () => {
    const value_ = config();
    expect(nodes(value_, "remote-database")).toEqual(["api-server", "broker", "redis"]);
    const secret = `remote-${Date.now()}-password`;
    const resources = plan(value_, "remote-database", { environment: { DB_PASSWORD: secret } });
    expect(resources.resources.db).toMatchObject({ target: { name: "remote", location: "remote", selectedBy: "profile" },
      secrets: [{ name: "password", env: "DB_PASSWORD", field: "resources.db.targets.remote.secrets.password", present: true }] });
    expect(value(resources, "db", "DB_URL")?.value).toBe("postgres://db.example.test:5432/app");
    expect(value(resources, "db", "DB_SCHEMA")).toEqual({ value: `db_${resources.ownerToken}`, source: "namespace", field: "resources.db.namespace" });
    expect(value(resources, "db", "DB_DATABASE")).toMatchObject({ value: "app", field: "resources.db.namespace.database" });
    expect(JSON.stringify(resources)).not.toContain(secret);
    expect(plan(value_, "remote-database", { environment: {} }).resources.db.secrets[0].present).toBe(false);
  });
});

describe("resource validation before side effects", () => {
  it("rejects unknown resources, targets and unselected consumption", () => {
    expect(() => config((v) => { v.processes.web.resources = ["missing"]; })).toThrow("unknown resource missing");
    expect(() => config((v) => { v.profiles.default.resources = { missing: "local" }; })).toThrow("unknown resource missing");
    expect(() => config((v) => { v.profiles.default.resources = { api: "staging" }; })).toThrow("unknown target staging");
    expect(() => config((v) => { v.resources.api.defaultTarget = "staging"; })).toThrow("unknown target staging");
    const unselected = config((v) => { delete v.resources.api.defaultTarget; });
    expect(() => createPlan(unselected)).toThrow(expect.objectContaining({ code: "DEVFN_RESOURCE_INVALID", message: expect.stringContaining("web consumes resource api") }));
  });

  it("rejects ambiguous names and undeclared exposed ports", () => {
    expect(() => config((v) => { v.resources.api_server = v.resources["admin-api"]; v.resources["api-server"] = v.resources["admin-api"]; })).toThrow("ambiguous");
    expect(() => config((v) => { v.resources["events-topic"] = { kind: "cache", targets: { local: { node: "redis", port: "redis" } } }; v.resources.events.topics = ["host"]; }))
      .toThrow("both emit DEVFN_RESOURCE_EVENTS_TOPIC_HOST");
    expect(() => config((v) => { v.resources.events.topics = ["order-v1", "order_v1"]; })).toThrow("ambiguous names");
    expect(() => config((v) => { v.resources.api.targets.local.port = "web"; })).toThrow("not an exposed port declared by api-server");
    expect(() => config((v) => { v.resources.api.targets.local.port = "missing"; })).toThrow("unknown port missing");
    expect(() => config((v) => { v.resources.api.targets.local.node = "missing"; })).toThrow("unknown lifecycle node missing");
  });

  it("rejects dependency cycles that resource consumption creates", () => {
    const cyclic = config((v) => {
      v.resources.callback = { kind: "service", defaultTarget: "local", targets: { local: { node: "web", port: "web", scheme: "http" } } };
      v.processes["api-server"].resources.push("callback");
    });
    expect(() => createPlan(cyclic)).toThrow(expect.objectContaining({ code: "DEVFN_DEPENDENCY_CYCLE" }));
    const self = config((v) => { v.processes["api-server"].resources.push("api"); });
    expect(() => createPlan(self, "remote-database")).toThrow(expect.objectContaining({ code: "DEVFN_DEPENDENCY_CYCLE" }));
  });

  it("rejects incompatible namespace sharing on one target but allows isolated neighbours", () => {
    const shared = config((v) => {
      v.resources.cache.namespace = { base: "app", sharing: "shared" };
      v.resources.sessions = { kind: "cache", defaultTarget: "local", namespace: { base: "app", sharing: "shared" }, targets: { local: { node: "redis", port: "redis" } } };
      v.processes["api-server"].resources.push("sessions");
    });
    expect(() => plan(shared)).toThrow(expect.objectContaining({ code: "DEVFN_RESOURCE_INVALID", message: expect.stringContaining("share namespace app:") }));
    const isolated = config((v) => {
      v.resources.sessions = { kind: "cache", defaultTarget: "local", targets: { local: { node: "redis", port: "redis" } } };
      v.processes["api-server"].resources.push("sessions");
    });
    const resources = plan(isolated);
    expect(value(resources, "sessions", "SESSIONS_PREFIX")?.value).not.toBe(value(resources, "cache", "CACHE_PREFIX")?.value);
    const browser = config((v) => {
      v.resources.session.namespace = { base: "app", sharing: "shared" };
      v.resources.preferences = { kind: "browser", namespace: { base: "app", sharing: "shared" }, cookies: ["sid"] };
      v.processes.admin.resources.push("preferences");
    });
    expect(() => plan(browser)).toThrow("share namespace app on the same browser target");
    const database = config((v) => {
      v.resources.ledger = { kind: "database", defaultTarget: "local", namespace: { base: "app" , sharing: "shared" }, targets: { local: { node: "postgres", port: "pg" } } };
      v.processes["api-server"].resources.push("ledger");
    });
    expect(() => plan(database)).toThrow("share namespace");
  });

  it("identifies one listener behind different port names, scheme aliases and loopback spellings", () => {
    const twoPortNames = config((v) => {
      v.ports.replica = {};
      v.services.redis.ports = { redis: 6379, replica: 6379 };
      v.resources.cache.namespace = { base: "data" };
      v.resources.sessions = { kind: "cache", defaultTarget: "local", namespace: { base: "data" }, targets: { local: { node: "redis", port: "replica" } } };
      v.processes["api-server"].resources.push("sessions");
    });
    expect(() => plan(twoPortNames, undefined, { ports: { ...PORTS, replica: 4109 } })).toThrow(expect.objectContaining({ code: "DEVFN_RESOURCE_INVALID", message: expect.stringContaining("share namespace data:") }));
    const leasedLoopback = config((v) => {
      v.resources.cache.namespace = { base: "data" };
      v.resources.sessions = { kind: "cache", defaultTarget: "dev", namespace: { base: "data" }, targets: { dev: { url: "redis://127.1:4107" } } };
      v.processes["api-server"].resources.push("sessions");
    });
    expect(() => plan(leasedLoopback)).toThrow("share namespace data:");
    // Preflight placeholders share one number and do not identify a listener.
    expect(() => plan(leasedLoopback, undefined, { ports: Object.fromEntries(Object.keys(PORTS).map((name) => [name, 1])) })).not.toThrow();
    const schemeAlias = config((v) => {
      v.resources.db.targets.remote.url = "postgres://db.example.test:5432";
      v.resources.ledger = { kind: "database", defaultTarget: "remote", namespace: { base: "db", level: "schema", database: "app" },
        targets: { remote: { url: "postgresql://DB.Example.Test.:5432", secrets: { password: "DB_PASSWORD" } } } };
      v.processes["api-server"].resources.push("ledger");
    });
    expect(() => plan(schemeAlias, "remote-database")).toThrow("share namespace");
    const distinctHosts = config((v) => {
      v.resources.ledger = { kind: "database", defaultTarget: "remote", namespace: { base: "db", level: "schema", database: "app" },
        targets: { remote: { url: "postgres://ledger.example.test:5432", secrets: { password: "DB_PASSWORD" } } } };
      v.processes["api-server"].resources.push("ledger");
    });
    expect(() => plan(distinctHosts, "remote-database")).not.toThrow();
  });

  it("selects only declared resources and targets, never inherited object properties", () => {
    const value_ = config((v) => {
      v.resources.constructor = { kind: "service", defaultTarget: "local", targets: { local: { node: "api-server", port: "api", scheme: "http" } } };
      v.processes.web.resources.push("constructor");
      v.profiles.default.resources = { api: "local" };
    });
    expect(nodes(value_)).toEqual(["admin", "api-server", "broker", "postgres", "redis", "web"]);
    expect(value(plan(value_), "constructor", "CONSTRUCTOR_URL")).toEqual({ value: "http://127.0.0.1:4101", source: "lease", field: "ports.api" });
    expect(() => config((v) => { v.profiles.default.resources = { api: "constructor" }; })).toThrow("unknown target constructor");
  });

  it("requires consumers to receive target secrets through their secret channel", () => {
    const leaky = config((v) => { v.processes["reports-server"].envAllowlist = []; v.processes["reports-server"].secretEnv = []; });
    expect(() => plan(leaky, "split-backends")).toThrow(expect.objectContaining({ code: "DEVFN_RESOURCE_INVALID", message: expect.stringContaining("needs secret DB_PASSWORD") }));
  });

  it("fails an invalid selection before creating lifecycle state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devfn-resource-preflight-"));
    const stateDir = path.join(root, "state");
    try {
      const orchestrator = new DevFnOrchestrator();
      await expect(orchestrator.up({ config: config((v) => { delete v.resources.api.defaultTarget; }), root, stateDir }))
        .rejects.toMatchObject({ code: "DEVFN_RESOURCE_INVALID" });
      const collision = config((v) => {
        v.resources.sessions = { kind: "cache", defaultTarget: "local", namespace: { base: "cache", sharing: "shared" }, targets: { local: { node: "redis", port: "redis" } } };
        v.resources.cache.namespace = { sharing: "shared" };
        v.processes["api-server"].resources.push("sessions");
      });
      await expect(orchestrator.up({ config: collision, root, stateDir })).rejects.toMatchObject({ code: "DEVFN_RESOURCE_INVALID" });
      await expect(access(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(path.join(root, ".devfn"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("resource references only Compose interpolates", () => {
  it("rejects an unreachable resource value before creating lifecycle state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devfn-resource-compose-reference-"));
    const stateDir = path.join(root, "state");
    try {
      await writeFile(path.join(root, "compose.yaml"), "services:\n  worker:\n    image: busybox\n    environment:\n      DEV_URL: ${DEVFN_RESOURCE_DEV_URL}\n");
      const value_ = validateDevFnConfig({ version: 1, project: { id: "resource-compose-reference" },
        services: { worker: { adapter: "compose", service: "worker" } },
        resources: { dev: { kind: "service", defaultTarget: "proxy", targets: { proxy: { url: "http://api.localhost:1355" } } } },
        profiles: { default: { services: ["worker"], resources: { dev: "proxy" } } } });
      await expect(new DevFnOrchestrator().up({ config: value_, root, stateDir }))
        .rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("Resource dev target proxy uses loopback name api.localhost") });
      await expect(access(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("resource selection independence and redaction", () => {
  it("selects the same targets whether a consumer runs natively or in Compose, and whatever its exposure", () => {
    const native = plan(config());
    const exposed = plan(config((v) => { v.processes.web.exposure = "public"; }));
    expect(exposed).toEqual(native);
    const containerized = plan(config((v) => {
      delete v.processes.web;
      v.services.web = { adapter: "compose", service: "web", ports: { web: 3000 }, resources: ["api", "session"] };
      v.profiles = { default: { processes: ["admin"], services: ["web"] } };
    }), undefined, { platform: "darwin" });
    for (const name of ["api", "db", "events", "cache", "session"]) {
      expect(containerized.resources[name].target).toEqual(native.resources[name].target);
      expect(containerized.resources[name].namespace).toEqual(native.resources[name].namespace);
    }
  });

  it("rejects credential-bearing target URLs and never records secret values", () => {
    expect(() => config((v) => { v.resources.db.targets.remote.url = "postgres://user:pw@db.example.test:5432"; })).toThrow("must not embed credentials");
    expect(() => config((v) => { v.resources.api.targets.remote.url = "https://api.example.test/v1?token=abc"; })).toThrow("must not contain a query");
    expect(() => config((v) => { v.resources.api.targets.remote.url = "https://api.example.test/key=abc"; })).toThrow("must not carry assignments");
    for (const url of ["https://api.example.test/token%3Dsentinel", "https://api.example.test/%3Ftoken=x", "https://api.example.test/v1/%40other"]) {
      expect(() => config((v) => { v.resources.api.targets.remote.url = url; })).toThrow(/percent-encoded|embed credentials/);
    }
    expect(() => config((v) => { v.resources.api.targets.remote.password = "abc"; })).toThrow("not a remote target field");
    const secret = `local-${Date.now()}-secret`;
    const resources = plan(config(), undefined, { environment: { DB_PASSWORD: secret } });
    expect(JSON.stringify(resources)).not.toContain(secret);
    for (const resource of Object.values(resources.resources)) {
      for (const entry of Object.values(resource.values)) expect(entry.value).not.toMatch(/\/\/[^/]*@/);
    }
  });
});

describe("resource namespaces", () => {
  it("isolates broker topics and consumer groups together per runtime owner", () => {
    const first = plan(config());
    const second = plan(config(), undefined, { ownerId: "owner-b" });
    const topic = (resources: ResourcePlan) => value(resources, "events", "EVENTS_TOPIC_ORDERS")!.value;
    const group = (resources: ResourcePlan) => value(resources, "events", "EVENTS_CONSUMER_GROUP")!.value;
    expect(topic(first)).toBe(`events.${first.ownerToken}.orders`);
    expect(group(first)).toBe(`events.${first.ownerToken}.workers`);
    expect(topic(first)).not.toBe(topic(second));
    expect(group(first)).not.toBe(group(second));
    const shared = config((v) => { v.resources.events.namespace = { base: "events", sharing: "shared" }; });
    expect(topic(plan(shared))).toBe("events.orders");
    expect(topic(plan(shared))).toBe(topic(plan(shared, undefined, { ownerId: "owner-b" })));
    expect(group(plan(shared))).toBe(group(plan(shared, undefined, { ownerId: "owner-b" })));
  });

  it("isolates cache, object, database and browser prefixes by default", () => {
    const value_ = config((v) => {
      v.resources.objects = { kind: "object-store", defaultTarget: "remote", targets: { remote: { url: "https://objects.example.test" } } };
      v.processes["api-server"].resources.push("objects");
    });
    const first = plan(value_);
    const second = plan(value_, undefined, { ownerId: "owner-b" });
    for (const [name, key] of [["cache", "CACHE_PREFIX"], ["objects", "OBJECTS_PREFIX"], ["db", "DB_SCHEMA"], ["session", "SESSION_COOKIE_SID"], ["session", "SESSION_STORAGE_DRAFT"]]) {
      expect(value(first, name, key)?.value).not.toBe(value(second, name, key)?.value);
    }
    expect(value(first, "cache", "CACHE_PREFIX")?.value).toBe(`cache:${first.ownerToken}:`);
    expect(value(first, "objects", "OBJECTS_PREFIX")?.value).toBe(`objects/${first.ownerToken}/`);
    expect(value(first, "session", "SESSION_COOKIE_SID")?.value).toBe(`session_${first.ownerToken}_sid`);
    expect(first.resources.cache.namespace).toEqual({ sharing: "isolated", prefix: `cache:${first.ownerToken}:`, field: "resources.cache" });
  });
});

describe("container and host endpoints", () => {
  function containerConsumer(provider: "process" | "service", mutate: (value: any) => void = () => undefined) {
    return config((v) => {
      v.services.worker = { adapter: "compose", service: "worker", resources: ["cache"] };
      if (provider === "process") {
        delete v.services.redis;
        v.processes.redis = { adapter: "command", command: ["redis-server"], ports: ["redis"] };
      }
      v.profiles.default = { services: ["worker"] };
      mutate(v);
    });
  }

  it("uses Compose-internal endpoints for siblings and leased loopback endpoints for the host", () => {
    const resources = plan(containerConsumer("service"));
    expect(value(resources, "cache", "CACHE_ENDPOINT")).toEqual({ value: "127.0.0.1:4107", source: "lease", field: "ports.redis" });
    expect(value(resources, "cache", "CACHE_HOST_ENDPOINT")?.value).toBe("127.0.0.1:4107");
    expect(value(resources, "cache", "CACHE_INTERNAL_ENDPOINT")).toEqual({ value: "redis:6379", source: "compose", field: "services.redis.ports.redis" });
    expect(resources.resources.cache.services.worker.DEVFN_RESOURCE_CACHE_URL).toEqual({ value: "redis://redis:6379", source: "compose", field: "services.redis.ports.redis" });
  });

  it("never injects host loopback as a container host", () => {
    expect(() => plan(containerConsumer("process"))).toThrow(expect.objectContaining({ code: "DEVFN_RESOURCE_INVALID", message: expect.stringContaining("cannot reach on this platform") }));
    const darwin = plan(containerConsumer("process"), undefined, { platform: "darwin" });
    expect(darwin.resources.cache.services.worker.DEVFN_RESOURCE_CACHE_URL).toEqual({ value: "redis://host.docker.internal:4107", source: "host-gateway", field: "platform:darwin" });
    expect(value(darwin, "cache", "CACHE_URL")?.value).toBe("redis://127.0.0.1:4107");
    expect(() => plan(containerConsumer("process"), undefined, { platform: "darwin", containerHostGateway: null })).toThrow("cannot reach");
    // A Compose provider on a disjoint network is reached through its leased host port, not its container name.
    const disjoint = plan(containerConsumer("service"), undefined, { platform: "darwin", composeNetworks: { redis: ["one"], worker: ["two"] } });
    expect(disjoint.resources.cache.services.worker.DEVFN_RESOURCE_CACHE_ENDPOINT).toMatchObject({ value: "host.docker.internal:4107", source: "host-gateway" });
    const loopbackRemote = containerConsumer("service", (v) => { v.resources.cache.targets.dev = { url: "redis://localhost:6390" }; v.profiles.default.resources = { cache: "dev" }; });
    expect(() => plan(loopbackRemote)).toThrow("cannot reach");
    expect(plan(loopbackRemote, undefined, { platform: "darwin" }).resources.cache.services.worker.DEVFN_RESOURCE_CACHE_URL).toMatchObject({ value: "redis://host.docker.internal:6390" });
  });

  it("recognizes loopback hosts whatever their scheme or spelling", () => {
    const remote = (url: string) => containerConsumer("service", (v) => { v.resources.cache.targets.dev = { url }; v.profiles.default.resources = { cache: "dev" }; });
    for (const url of ["redis://127.1:6390", "redis://0.0.0.0:6390", "redis://LOCALHOST.:6390", "redis://[::ffff:127.0.0.1]:6390", "redis://[::]:6390", "redis://0x7f.1:6390"]) {
      expect(() => plan(remote(url)), url).toThrow("cannot reach");
      expect(plan(remote(url), undefined, { platform: "darwin" }).resources.cache.services.worker.DEVFN_RESOURCE_CACHE_URL, url)
        .toEqual({ value: "redis://host.docker.internal:6390", source: "host-gateway", field: "platform:darwin" });
    }
    // A *.localhost listener such as the DevFn proxy routes by name, which a gateway rewrite would drop.
    for (const platform of ["linux", "darwin"] as const) {
      expect(() => plan(remote("http://api.localhost:1355"), undefined, { platform })).toThrow(expect.objectContaining({ code: "DEVFN_RESOURCE_INVALID", message: expect.stringContaining("loopback name api.localhost") }));
    }
    expect(plan(remote("redis://cache.example.test:6390")).resources.cache.services.worker.DEVFN_RESOURCE_CACHE_URL).toMatchObject({ value: "redis://cache.example.test:6390", source: "manifest" });
  });
});

describe("endpoint resolver handoff", () => {
  const resolve = (value_: DevFnConfig, resources?: ResourcePlan, profile?: string) => {
    const lifecycle = createPlan(value_, profile);
    return resolveEndpointTemplates({ config: value_, plan: lifecycle, ownerId: "owner-a", ports: PORTS,
      composeNetworks: Object.fromEntries(lifecycle.nodes.filter((node) => node.kind === "service").map((node) => [node.name, ["shared"]])),
      ...(resources ? { resources } : {}) });
  };

  it("supplies selected values to templates, argv and environment without changing precedence", () => {
    const value_ = config((v) => { v.processes.web.env.TOPIC = "{{env.DEVFN_RESOURCE_EVENTS_TOPIC_ORDERS}}"; });
    const resources = plan(value_);
    const resolved = resolve(value_, resources);
    expect(resolved.nodes.web.environment.API_URL).toBe("http://127.0.0.1:4101");
    expect(resolved.nodes.web.command).toEqual(["node", "web.mjs", "http://127.0.0.1:4101"]);
    expect(resolved.nodes.web.environment.TOPIC).toBe(`events.${resources.ownerToken}.orders`);
    expect(resolved.generated.DEVFN_RESOURCE_SESSION_COOKIE_SID).toBe(`session_${resources.ownerToken}_sid`);
    expect(resolved.resources).toBe(resources);
    const remote = resolve(config(), plan(config(), "remote-backend"), "remote-backend");
    expect(remote.nodes.web.environment.API_URL).toBe("https://api.example.test/v1");
  });

  it("leaves missing endpoint references to the endpoint resolver", () => {
    const missing = config((v) => { v.processes.web.env.OTHER = "{{env.DEVFN_RESOURCE_UNKNOWN_URL}}"; });
    expect(() => resolve(missing, plan(missing))).toThrow(expect.objectContaining({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("missing reference DEVFN_RESOURCE_UNKNOWN_URL") }));
    // Without a supplied plan, resource keys are ordinary missing references.
    expect(() => resolve(config())).toThrow(expect.objectContaining({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringMatching(/missing reference DEVFN_RESOURCE_(?:ADMIN_)?API_URL/) }));
  });

  it("gives Compose nodes container values and rejects their unreachable references with the resource reason", () => {
    const value_ = config((v) => {
      v.services.worker = { adapter: "compose", service: "worker", env: { API: "{{env.DEVFN_RESOURCE_API_URL}}", CACHE: "{{env.DEVFN_RESOURCE_CACHE_URL}}" } };
      v.profiles.default = { processes: ["web"], services: ["worker", "redis"] };
    });
    const linux = plan(value_);
    expect(() => resolve(value_, linux)).toThrow(expect.objectContaining({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("Resource api target local listens on host loopback") }));
    const darwin = plan(value_, undefined, { platform: "darwin" });
    const resolved = resolve(value_, darwin);
    expect(resolved.nodes.worker.environment).toMatchObject({ API: "http://host.docker.internal:4101", CACHE: "redis://redis:6379" });
    expect(resolved.nodes.web.environment.DEVFN_RESOURCE_CACHE_URL).toBe("redis://127.0.0.1:4107");
  });

  it("applies the resolver's decoded URL credential checks to resource values without a template", () => {
    const value_ = config();
    const resources = plan(value_, "remote-backend");
    // No template references DEVFN_RESOURCE_API_ENDPOINT, so template expansion never inspects it.
    resources.resources.api.values.DEVFN_RESOURCE_API_ENDPOINT = { value: "https://api.example.test/token%3Dsentinel", source: "manifest", field: "resources.api.targets.remote.url" };
    expect(() => resolve(value_, resources, "remote-backend")).toThrow(expect.objectContaining({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("credential-bearing URL") }));
  });

  it("rejects a plan made for another owner or profile", () => {
    const value_ = config();
    expect(() => resolve(value_, plan(value_, undefined, { ownerId: "owner-b" }))).toThrow("another profile or lifecycle owner");
    expect(() => resolve(value_, plan(value_, "split-backends"))).toThrow("another profile or lifecycle owner");
  });

  it("keeps manifests without resources on the previous resolution", () => {
    const legacy = validateDevFnConfig({ version: 1, project: { id: "legacy" }, ports: { api: {} },
      processes: { api: { adapter: "command", command: ["node", "api.mjs"], ports: ["api"], dependsOn: ["db", "db"] }, db: { adapter: "command", command: ["db"] } },
      profiles: { default: { processes: ["api"] } } });
    const lifecycle = createPlan(legacy);
    expect(lifecycle.nodes.find((node) => node.name === "api")?.dependencies).toEqual(["db", "db"]);
    const resolved = resolveEndpointTemplates({ config: legacy, plan: lifecycle, ownerId: "owner-a", ports: { api: 4101 } });
    expect(resolved.resources).toBeUndefined();
    expect(Object.keys(resolved.generated).some((key) => key.startsWith("DEVFN_RESOURCE_"))).toBe(false);
  });
});

describe("real local resource handoff", () => {
  it("starts a local backend and client wired through selected resources", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devfn-resource-native-"));
    const stateDir = path.join(root, "state");
    const observed = path.join(root, "observed.json");
    const server = `import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
const role = process.argv[2];
if (role === "client") {
  const response = await fetch(process.env.API_URL + "/health");
  await writeFile(process.env.OBSERVED_FILE, JSON.stringify({ status: response.status, api: process.env.API_URL, db: process.env.DEVFN_RESOURCE_DB_URL,
    topic: process.env.DEVFN_RESOURCE_EVENTS_TOPIC_JOBS, group: process.env.DEVFN_RESOURCE_EVENTS_CONSUMER_GROUP, secret: Boolean(process.env.REMOTE_DB_PASSWORD) }));
}
const port = Number(role === "client" ? process.env.DEVFN_PORT_WEB : process.env.DEVFN_PORT_API);
createServer((request, response) => { response.writeHead(200); response.end("ok"); }).listen(port, "127.0.0.1");
`;
    const value_ = validateDevFnConfig({ version: 1, project: { id: "resource-native" }, ports: { api: {}, web: {} },
      processes: {
        api: { adapter: "command", command: [process.execPath, "server.mjs", "api"], ports: ["api"], health: { type: "http", port: "api", timeoutMs: 10_000 } },
        web: { adapter: "command", command: [process.execPath, "server.mjs", "client"], ports: ["web"], resources: ["backend", "db", "events"],
          health: { type: "http", port: "web", timeoutMs: 10_000 }, env: { OBSERVED_FILE: observed, API_URL: "{{env.DEVFN_RESOURCE_BACKEND_URL}}" },
          envAllowlist: ["REMOTE_DB_PASSWORD"], secretEnv: ["REMOTE_DB_PASSWORD"] },
      },
      resources: {
        backend: { kind: "service", defaultTarget: "local", targets: { local: { node: "api", port: "api", scheme: "http" } } },
        db: { kind: "database", defaultTarget: "remote", targets: { remote: { url: "postgres://db.example.test:5432", secrets: { password: "REMOTE_DB_PASSWORD" } } } },
        events: { kind: "broker", defaultTarget: "remote", topics: ["jobs"], targets: { remote: { url: "kafka://broker.example.test:9092" } } },
      },
      profiles: { default: { processes: ["web"] } } });
    const secret = `remote-${Date.now()}-password`;
    const original = process.env.REMOTE_DB_PASSWORD;
    process.env.REMOTE_DB_PASSWORD = secret;
    await writeFile(path.join(root, "server.mjs"), server);
    const orchestrator = new DevFnOrchestrator();
    try {
      // Remote targets need no public-exposure confirmation.
      const receipt = await orchestrator.up({ config: value_, root, stateDir });
      const ports = Object.fromEntries(receipt.allocations.map((allocation) => [allocation.service, allocation.port]));
      const observation = JSON.parse(await readFile(observed, "utf8"));
      const token = receipt.resources!.ownerToken;
      expect(observation).toEqual({ status: 200, api: `http://127.0.0.1:${ports.api}`, db: `postgres://db.example.test:5432/db_${token}`,
        topic: `events.${token}.jobs`, group: `events.${token}`, secret: true });
      expect(receipt.resources?.resources.backend).toMatchObject({ provider: { node: "api" }, consumers: ["web"] });
      const persisted = await readFile(receiptPath(value_, root, receipt.instanceId), "utf8");
      expect(persisted).not.toContain(secret);
      expect(persisted).toContain("resources.db.targets.remote.secrets.password");
    } finally {
      await orchestrator.down({ config: value_, root, stateDir }).catch(() => undefined);
      if (original === undefined) delete process.env.REMOTE_DB_PASSWORD; else process.env.REMOTE_DB_PASSWORD = original;
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("real local resource reselection", () => {
  it("replaces a running lifecycle when its selected target changes behind a credential-like name", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devfn-resource-reselect-"));
    const stateDir = path.join(root, "state");
    const observed = path.join(root, "observed.txt");
    await writeFile(path.join(root, "client.mjs"), `import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
await writeFile(process.env.OBSERVED_FILE, process.env.DEVFN_RESOURCE_AUTH_URL);
createServer((request, response) => { response.writeHead(200); response.end("ok"); }).listen(Number(process.env.DEVFN_PORT_WEB), "127.0.0.1");
`);
    const manifest = (url: string) => validateDevFnConfig({ version: 1, project: { id: "resource-reselect" }, ports: { web: {} },
      processes: { web: { adapter: "command", command: [process.execPath, "client.mjs"], ports: ["web"], resources: ["auth"],
        health: { type: "http", port: "web", timeoutMs: 10_000 }, env: { OBSERVED_FILE: observed } } },
      resources: { auth: { kind: "service", defaultTarget: "remote", targets: { remote: { url } } } },
      profiles: { default: { processes: ["web"] } } });
    const orchestrator = new DevFnOrchestrator();
    try {
      await orchestrator.up({ config: manifest("https://one.example.test"), root, stateDir });
      expect(await readFile(observed, "utf8")).toBe("https://one.example.test");
      await expect(orchestrator.up({ config: manifest("https://one.example.test"), root, stateDir })).rejects.toMatchObject({ code: "DEVFN_ALREADY_RUNNING" });
      const replaced = await orchestrator.up({ config: manifest("https://two.example.test"), root, stateDir });
      expect(await readFile(observed, "utf8")).toBe("https://two.example.test");
      expect(replaced.resources?.resources.auth.remote).toEqual({ url: "https://two.example.test" });
    } finally {
      await orchestrator.down({ config: manifest("https://two.example.test"), root, stateDir }).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});

describe("real Compose resource endpoints", () => {
  it.skipIf(process.env.DEVFN_REAL_COMPOSE !== "1")("reaches a Compose sibling internally and a native backend through the platform host gateway", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devfn-resource-compose-"));
    const stateDir = path.join(root, "state");
    const observed = path.join(root, "observed");
    await mkdir(observed);
    await writeFile(path.join(root, "api.mjs"), `import { createServer } from "node:http";
createServer((request, response) => { response.writeHead(200); response.end("api"); }).listen(Number(process.env.DEVFN_PORT_API), process.env.HOST);
`);
    await writeFile(path.join(root, "store.mjs"), `import { createServer } from "node:http";
createServer((request, response) => { response.writeHead(200); response.end("store"); }).listen(8080, "0.0.0.0");
`);
    await writeFile(path.join(root, "client.mjs"), `import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
const backend = await fetch(process.env.BACKEND_URL).then((response) => response.text());
const store = await fetch(process.env.STORE_URL).then((response) => response.text());
await writeFile("/observed/client.json", JSON.stringify({ backendUrl: process.env.BACKEND_URL, storeUrl: process.env.STORE_URL, backend, store }));
createServer((request, response) => { response.writeHead(200); response.end("ok"); }).listen(8081, "0.0.0.0");
`);
    await writeFile(path.join(root, "compose.yaml"), `services:
  store:
    image: node:22-alpine
    volumes: ["./store.mjs:/app/store.mjs:ro"]
    command: ["node", "/app/store.mjs"]
  client:
    image: node:22-alpine
    volumes: ["./client.mjs:/app/client.mjs:ro", "./observed:/observed"]
    command: ["node", "/app/client.mjs"]
    environment:
      BACKEND_URL: "\${DEVFN_RESOURCE_BACKEND_URL}"
      STORE_URL: "\${DEVFN_RESOURCE_STORE_URL}"
`);
    const value_ = validateDevFnConfig({ version: 1, project: { id: "resource-compose" }, ports: { api: {}, store: {}, client: {} },
      processes: { api: { adapter: "command", command: [process.execPath, "api.mjs"], ports: ["api"], health: { type: "http", port: "api", timeoutMs: 10_000 } } },
      services: {
        store: { adapter: "compose", service: "store", ports: { store: 8080 }, health: { type: "http", port: "store", timeoutMs: 30_000 } },
        client: { adapter: "compose", service: "client", ports: { client: 8081 }, resources: ["backend", "store"], health: { type: "http", port: "client", timeoutMs: 30_000 } },
      },
      resources: {
        backend: { kind: "service", defaultTarget: "local", targets: { local: { node: "api", port: "api", scheme: "http" } } },
        store: { kind: "service", defaultTarget: "local", targets: { local: { node: "store", port: "store", scheme: "http" } } },
      },
      profiles: { default: { services: ["client"] } } });
    const orchestrator = new DevFnOrchestrator();
    let project: string | undefined;
    try {
      if (process.platform === "linux") {
        await expect(orchestrator.up({ config: value_, root, stateDir })).rejects.toMatchObject({ code: "DEVFN_RESOURCE_INVALID" });
        return;
      }
      const receipt = await orchestrator.up({ config: value_, root, stateDir });
      project = receipt.services[0]?.projectName;
      const ports = Object.fromEntries(receipt.allocations.map((allocation) => [allocation.service, allocation.port]));
      expect(JSON.parse(await readFile(path.join(observed, "client.json"), "utf8"))).toEqual({
        backendUrl: `http://host.docker.internal:${ports.api}`, storeUrl: "http://store:8080", backend: "api", store: "store" });
      expect(receipt.resources?.resources.backend.services.client.DEVFN_RESOURCE_BACKEND_URL).toMatchObject({ source: "host-gateway" });
    } finally {
      await orchestrator.down({ config: value_, root, stateDir }).catch(() => undefined);
      if (project) await promisify(execFile)("docker", ["network", "rm", `${project}_default`]).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
