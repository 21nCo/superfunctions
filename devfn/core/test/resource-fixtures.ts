import { validateDevFnConfig, type DevFnConfig } from "@devfn/config";

/** Same-named Compose providers in two projects, each consumed by a worker of its project. */
export function sameServiceNames(kind: "cache" | "database" | "broker"): DevFnConfig {
  const resource = (node: string) => ({ kind, defaultTarget: "local", namespace: { base: "data" }, ...(kind === "broker" ? { topics: ["jobs"] } : {}),
    targets: { local: { node, port: node } } });
  return validateDevFnConfig({ version: 1, project: { id: "resource-same-names" }, ports: { ra: {}, rb: {} },
    services: {
      ra: { adapter: "compose", service: "redis", projectName: "alpha", ports: { ra: 6379 } },
      rb: { adapter: "compose", service: "redis", projectName: "beta", ports: { rb: 6379 } },
      wa: { adapter: "compose", service: "wa", projectName: "alpha", resources: ["c1"] },
      wb: { adapter: "compose", service: "wb", projectName: "beta", resources: ["c2"] },
    },
    resources: { c1: resource("ra"), c2: resource("rb") },
    profiles: { default: { services: ["wa", "wb"] } } });
}
