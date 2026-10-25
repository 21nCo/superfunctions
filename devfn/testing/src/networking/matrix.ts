/**
 * The DevFn networking qualification matrix: every live boundary the DEV-2
 * networking contract must prove on real hosts, with the prerequisites each
 * needs and the assertions a run must observe before it may call a scenario
 * passed. Fixture references name the local contract tests that cover the
 * same behavior without real hosts or providers; they are never live evidence.
 */

import { createHash } from "node:crypto";

export const NETWORKING_QUALIFICATION_CONTRACT = "devfn.networking-qualification/v1";
/** The issue that executes the live matrix. */
export const LIVE_MATRIX_TARGET = "DEV-17";
/** Hosts the v0.1 contract can qualify. Windows has no claim without Windows evidence. */
export const QUALIFIED_PLATFORMS = ["darwin", "linux"] as const;
export type QualifiedPlatform = typeof QUALIFIED_PLATFORMS[number];

export type PrerequisiteId =
  | "supported-host" | "devfn-cli" | "git" | "caddy" | "process-tools" | "proxy-ports" | "docker-compose"
  | "approval" | "registered-domain" | "google-oauth" | "browser-operator"
  | "cloudflare" | "ngrok-reserved" | "ngrok-ephemeral";

/** Disposable resources a scenario may create. Each must be removed and its absence read back. */
export type ResourceKind = "fixture-repository" | "runtime" | "proxy" | "run-processes" | "registered-domain" | "oauth-relay" | "tunnel-binding" | "public-hostname";

export interface PlannedAssertion { id: string; claim: string }

export interface QualificationScenario {
  id: string;
  /** Row of the deferred live matrix this scenario proves. */
  row: 1 | 2 | 3 | 4 | 5;
  title: string;
  prerequisites: readonly PrerequisiteId[];
  /** A scenario passes only when a live run observes every one of these, and none fails. */
  assertions: readonly PlannedAssertion[];
  resources: readonly ResourceKind[];
  /** Repository-relative contract tests covering the behavior locally; never a live pass. */
  fixtureEvidence: readonly string[];
}

export const DEFERRED_ROWS: Readonly<Record<QualificationScenario["row"] | 6, string>> = {
  1: "Real macOS and Linux pre-start native/Compose endpoint wiring, two simultaneous worktrees, hostname/path isolation, internal TLS and registered-domain resolution.",
  2: "An approved nonproduction owned domain and Google OAuth client complete login in both worktrees through one redirect URI, with state/nonce/PKCE/replay and token-exchange evidence.",
  3: "Real Cloudflare and ngrok sandbox journeys prove selected public routes, private-route denial, DNS/Host/SNI/origin TLS and URL timing.",
  4: "Startup failure, concurrent change, crash recovery, one-worktree stop and provider reload preserve unrelated runtimes; disposable resources are deleted and absence read back.",
  5: "The versioned opaque-owner/endpoint interface DEV-3 consumes and verified host/provider limitations; no Windows claim without Windows evidence.",
  6: "DEV-2 completes only after every scenario passes live on macOS and Linux at the merged head.",
};

const HOST: readonly PrerequisiteId[] = ["supported-host", "devfn-cli", "git", "caddy", "process-tools", "proxy-ports"];
const a = (id: string, claim: string): PlannedAssertion => ({ id, claim });
const tunnel = (id: string, title: string, prerequisite: PrerequisiteId, timing: "pre-start" | "post-start", dns: string): QualificationScenario => ({
  id, row: 3, title, prerequisites: [...HOST, "approval", prerequisite],
  assertions: [
    a("url-timing", timing === "pre-start" ? "devfn tunnel urls reports each selected URL before start, and the started lifecycle publishes exactly that URL." : "Before start the route is listed as assigned after start with no URL; the started lifecycle reports the provider-assigned URL."),
    a("public-route-served", "The selected route answers its own marker at its public URL through real public DNS and the provider edge."),
    a("private-route-denied", "The provider holds no public name for a route the profile did not select; the public origin denies that route's own name (403, deny) and refuses it as a forged Host (421); an unselected path on a public name gets the origin's marked fallback."),
    a("dns-host-sni", `${dns} The edge certificate verifies for the public hostname (SNI), and a mismatched Host header is not routed.`),
    a("origin-tls", "The DevFn public origin presents a certificate for each public hostname that verifies against the Caddy internal root, without OS trust changes."),
    a("withdrawn-absent", "After devfn down the public URL stops serving, tunnel status lists no hostname or outstanding withdrawal, and a provider read-back finds no DevFn-owned record."),
  ],
  resources: ["fixture-repository", "runtime", "tunnel-binding", "public-hostname"],
  fixtureEvidence: ["devfn/proxy/test/tunnel-service.test.ts", "devfn/proxy/test/tunnel-adapter.test.ts", "devfn/core/test/tunnel-real-origin.test.ts",
    prerequisite === "cloudflare" ? "devfn/core/test/tunnel-lifecycle.test.ts" : "devfn/core/test/tunnel-ngrok-lifecycle.test.ts", ...(prerequisite === "cloudflare" ? [] : ["devfn/proxy/test/tunnel-ngrok.test.ts"])],
});

export const NETWORKING_MATRIX: readonly QualificationScenario[] = [
  { id: "host.native-prestart", row: 1, title: "Native process endpoint wiring before start", prerequisites: HOST,
    assertions: [
      a("env-before-start", "The native process reads its DEVFN_URL_/DEVFN_PORT_ values and DEVFN_INSTANCE_ID at its first instruction, before it listens."),
      a("receipt-matches", "The values the process saw equal the ready receipt's leased port and devfn url output."),
    ],
    resources: ["fixture-repository", "runtime"], fixtureEvidence: ["devfn/core/test/endpoints.test.ts", "devfn/core/test/startup-fixture.test.ts"] },
  { id: "host.compose-prestart", row: 1, title: "Compose endpoint wiring before start", prerequisites: [...HOST, "docker-compose"],
    assertions: [
      a("sibling-url", "On the pinned local Docker engine, a Compose container receives its sibling's container-network URL before it starts and reaches it."),
      a("loopback-mapping", "The container's leased host port is published on loopback only and answers at the receipt's direct URL."),
    ],
    resources: ["fixture-repository", "runtime"], fixtureEvidence: ["devfn/compose/test/override.test.ts", "devfn/compose/test/path-contract.test.ts", "devfn/core/test/endpoints.test.ts"] },
  { id: "host.two-worktrees", row: 1, title: "Two simultaneous worktrees", prerequisites: HOST,
    assertions: [
      a("distinct-owners", "Two worktrees of one repository run at once with distinct instance IDs, leased ports and hostnames."),
      a("own-marker", "Each worktree's hostname serves only that worktree's marker through the shared DevFn Caddy."),
    ],
    resources: ["fixture-repository", "runtime"], fixtureEvidence: ["devfn/core/test/domain-routing.test.ts", "devfn/ports/test/registry.test.ts"] },
  { id: "host.route-isolation", row: 1, title: "Hostname and path isolation", prerequisites: HOST,
    assertions: [
      a("path-prefix", "A prefix route reaches its own process with the prefix stripped, at its segment boundary only."),
      a("unselected-denied", "An unselected path on a routed host and an unknown host both return 404 and reach no process."),
      a("no-cross-worktree", "Requests carrying one worktree's hostname never reach the other worktree's processes."),
    ],
    resources: ["fixture-repository", "runtime"], fixtureEvidence: ["devfn/proxy/test/domain-routing.test.ts", "devfn/proxy/test/real-caddy.test.ts", "devfn/core/test/domain-routing.test.ts"] },
  { id: "host.internal-tls", row: 1, title: "Internal TLS without trust installation", prerequisites: HOST,
    assertions: [
      a("verified-sni", "Each TLS route presents a certificate for its own hostname that verifies against the DevFn Caddy internal root."),
      a("http-redirect", "Plain HTTP to a TLS route redirects to HTTPS."),
      a("no-trust-install", "The operating system trust stores are unchanged across startup and TLS use: DevFn installed no CA. A root the operator trusted beforehand is reported, not attributed to DevFn."),
    ],
    resources: ["fixture-repository", "runtime"], fixtureEvidence: ["devfn/proxy/test/real-caddy.test.ts", "devfn/proxy/test/proxy.test.ts"] },
  { id: "host.registered-domain", row: 1, title: "Registered-domain resolution", prerequisites: [...HOST, "approval", "registered-domain"],
    assertions: [
      a("loopback-only", "The approved domain registers only while its names resolve exclusively to loopback; DevFn edits no resolver."),
      a("worktree-alias", "Each worktree's registered alias resolves to loopback and serves that worktree over the registration's TLS."),
      a("primary-alias", "Only the primary worktree receives the canonical <host>.<domain> alias."),
    ],
    resources: ["fixture-repository", "runtime", "registered-domain"], fixtureEvidence: ["devfn/core/test/registered-domain-startup.test.ts", "devfn/config/test/domain-routes.test.ts", "devfn/core/test/identity.test.ts"] },
  { id: "oauth.google-two-worktrees", row: 2, title: "Google OAuth login in two worktrees through one redirect URI",
    prerequisites: [...HOST, "approval", "registered-domain", "google-oauth", "browser-operator"],
    assertions: [
      a("one-redirect-uri", "Both worktrees send the provider the same registered relay redirect URI, unchanged in the token exchange."),
      a("login-both", "A real Google login completes in each worktree: the relay delivers its callback to that worktree's own host, which honors the session it established."),
      a("state-nonce-pkce", "Each client validated its own state at its callback, the ID token nonce, and an S256 PKCE verifier the provider accepted."),
      a("replay-rejected", "Replaying a consumed callback at once is rejected by the relay as replayed (403) and creates no session."),
      a("token-exchange", "Each token exchange returned tokens to the worktree that started the flow, and no code or token reached the receipt."),
    ],
    resources: ["fixture-repository", "runtime", "registered-domain", "oauth-relay"],
    fixtureEvidence: ["devfn/proxy/test/oauth-relay.test.ts", "devfn/proxy/test/oauth-relay-service.test.ts", "devfn/core/test/oauth-relay-lifecycle.test.ts", "devfn/core/test/oauth-relay-owner.test.ts"] },
  tunnel("tunnel.cloudflare", "Cloudflare named-tunnel public journey", "cloudflare", "pre-start", "Public DNS for the hostname is a DevFn-owned record routing to the approved tunnel."),
  tunnel("tunnel.ngrok-reserved", "ngrok reserved-endpoint public journey", "ngrok-reserved", "pre-start", "The hostname is under the account's reserved wildcard domain and resolves publicly."),
  tunnel("tunnel.ngrok-ephemeral", "ngrok ephemeral-endpoint public journey", "ngrok-ephemeral", "post-start", "The assigned hostname resolves publicly only while the connector runs."),
  { id: "recovery.startup-failure", row: 4, title: "Startup failure preserves unrelated runtimes", prerequisites: HOST,
    assertions: [
      a("failure-cleaned", "A failing start reports a stable error, leaves no process, lease or route of its own, and its retry succeeds once fixed."),
      a("sentinel-preserved", "A running sentinel worktree keeps serving with the same process and URL throughout."),
    ],
    resources: ["fixture-repository", "runtime"], fixtureEvidence: ["devfn/core/test/teardown-evidence.test.ts", "devfn/core/test/orchestrator.test.ts"] },
  { id: "recovery.concurrent-change", row: 4, title: "Concurrent starts and configuration change", prerequisites: HOST,
    assertions: [
      a("single-owner", "Concurrent starts of one worktree leave exactly one running lifecycle, and the other start fails without side effects."),
      a("change-detected", "A changed manifest degrades status and a restart applies it to that worktree only."),
      a("sentinel-preserved", "A running sentinel worktree keeps serving with the same process and URL throughout."),
    ],
    resources: ["fixture-repository", "runtime"], fixtureEvidence: ["devfn/ports/test/lock.test.ts", "devfn/ports/test/lock-takeover.test.ts", "devfn/core/test/replacement-contract.test.ts"] },
  { id: "recovery.crash", row: 4, title: "Crash recovery", prerequisites: HOST,
    assertions: [
      a("crash-detected", "A killed process makes status report the worktree as not ready, and ports gc succeeds after a devfn up is killed mid-start."),
      a("restart-recovers", "A restart of the crashed worktree succeeds with its routes restored, and once the killed start's lifecycle lock is stale a new start succeeds and no process of the killed start survives."),
      a("sentinel-preserved", "A running sentinel worktree keeps serving with the same process and URL throughout."),
    ],
    resources: ["fixture-repository", "runtime"], fixtureEvidence: ["devfn/ports/test/claim-evidence.test.ts", "devfn/core/test/teardown-evidence.test.ts", "devfn/processes/test/supervisor.test.ts"] },
  { id: "recovery.one-worktree-stop", row: 4, title: "Stopping one worktree", prerequisites: HOST,
    assertions: [
      a("stopped-withdrawn", "devfn down removes that worktree's processes, routes and leases."),
      a("sentinel-preserved", "A running sentinel worktree keeps serving with the same process and URL throughout."),
    ],
    resources: ["fixture-repository", "runtime"], fixtureEvidence: ["devfn/core/test/teardown-evidence.test.ts", "devfn/cli/test/cli.test.ts"] },
  { id: "recovery.proxy-reload", row: 4, title: "Proxy reload preserves other routes", prerequisites: HOST,
    assertions: [
      a("reload-preserves", "Adding and removing another worktree's routes reloads Caddy while the sentinel route answers on every probe."),
      a("sentinel-preserved", "A running sentinel worktree keeps serving with the same process and URL throughout."),
    ],
    resources: ["fixture-repository", "runtime"], fixtureEvidence: ["devfn/proxy/test/activation.test.ts", "devfn/core/test/proxy-readiness.test.ts"] },
  { id: "recovery.tunnel-reload", row: 4, title: "Tunnel recovery preserves other owners' public routes", prerequisites: [...HOST, "approval", "cloudflare"],
    assertions: [
      a("withdraw-one", "Stopping one of two public worktrees withdraws only its hostname; the other keeps serving publicly."),
      a("recover-preserves", "devfn tunnel recover restarts the connector and the remaining owner's public route still serves."),
      a("withdrawn-absent", "After both stop, tunnel status lists nothing and a provider read-back finds no DevFn-owned record."),
    ],
    resources: ["fixture-repository", "runtime", "tunnel-binding", "public-hostname"], fixtureEvidence: ["devfn/proxy/test/tunnel-service.test.ts", "devfn/core/test/tunnel-lifecycle.test.ts"] },
  { id: "interface.owner-endpoint", row: 5, title: "Opaque owner and endpoint interface", prerequisites: HOST,
    assertions: [
      a("owner-opaque", "The process's DEVFN_INSTANCE_ID equals the receipt owner, and its hostname carries only an owner digest, never the owner value or worktree path."),
      a("resolver-matches", "The published resolver, given the live owner and leased ports, reproduces every generated value each process saw."),
    ],
    resources: ["fixture-repository", "runtime"], fixtureEvidence: ["devfn/core/test/endpoints.test.ts", "devfn/compose/test/override.test.ts", "devfn/testing/test/networking-qualification.test.ts"] },
];

/** The opaque label local hostnames carry for an owner: o- and the first 20 hex digits of its SHA-256. */
export const ownerLabel = (owner: string): string => `o-${createHash("sha256").update(owner).digest("hex").slice(0, 20)}`;

/** The opaque-owner endpoint interface DEV-3 consumes, as this harness qualifies it; the contract tests bind it to @devfn/core. */
export const ENDPOINT_INTERFACE = {
  version: 1,
  resolver: "@devfn/core resolveEndpointTemplates",
  owner: "opaque string supplied by the caller; hostnames carry only o-<20 hex sha256 digest>",
  outputs: ["generated", "environment", "directUrls", "composeUrls", "nodes"],
} as const;
