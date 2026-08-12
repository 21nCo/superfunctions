#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const graph = JSON.parse(readFileSync(path.join(root, "mdfn/package-graph.json"), "utf8"));
const failures = [];
const nodes = [...(graph.stable ?? []), ...(graph.optional ?? [])];
const nodeNames = new Set(nodes.map((node) => node.name));
const stableNames = new Set((graph.stable ?? []).map((node) => node.name));

function fail(code, detail = {}) { failures.push({ code, ...detail }); }
function files(directory) { return existsSync(directory) ? readdirSync(directory).flatMap((entry) => { const absolute = path.join(directory, entry); return statSync(absolute).isDirectory() && !["dist", "node_modules", ".conduct"].includes(entry) ? files(absolute) : [absolute]; }) : []; }

if (graph.schemaVersion !== 1 || graph.graphId !== "mdfn-1.0-dag") fail("MDFN_GRAPH_SCHEMA_INVALID");
if (JSON.stringify(graph.frameworks) !== JSON.stringify(["react", "svelte", "solid"])) fail("MDFN_GRAPH_FRAMEWORK_SET_INVALID");
if (nodes.length !== 24 || stableNames.size !== 17) fail("MDFN_GRAPH_PACKAGE_COUNT_INVALID", { total: nodes.length, stable: stableNames.size });
if (nodeNames.size !== nodes.length) fail("MDFN_GRAPH_DUPLICATE_PACKAGE");

const dependencies = new Map();
for (const node of nodes) {
  const manifestPath = path.join(root, node.path, "package.json");
  if (!existsSync(manifestPath)) { fail("MDFN_GRAPH_PACKAGE_MISSING", { package: node.name }); continue; }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== node.name) fail("MDFN_GRAPH_NAME_MISMATCH", { package: node.name, actual: manifest.name });
  if (manifest.private === true || !manifest.publishConfig || !manifest.files) fail("MDFN_GRAPH_PUBLICATION_METADATA_MISSING", { package: node.name });
  const actual = Object.keys(manifest.dependencies ?? {}).filter((name) => name === "mdfn" || name.startsWith("@mdfn/")).sort();
  const expected = [...node.dependencies].sort();
  dependencies.set(node.name, actual);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("MDFN_GRAPH_EDGE_MISMATCH", { package: node.name, expected, actual });
  if (stableNames.has(node.name)) for (const dependency of actual) if (!stableNames.has(dependency)) fail("MDFN_GRAPH_STABLE_TO_OPTIONAL_EDGE", { package: node.name, dependency });
  const source = files(path.join(root, node.path, "src")).filter((file) => /\.(?:ts|tsx|svelte)$/.test(file)).map((file) => readFileSync(file, "utf8")).join("\n");
  if (["@mdfn/core", "@mdfn/markdown", "@mdfn/render", "@mdfn/extensions", "@mdfn/testing", "@mdfn/registry", "mdfn"].includes(node.name) && /(?:from|import\()\s*["'](?:react|svelte|solid-js|node:)/.test(source)) fail("MDFN_GRAPH_ENVIRONMENT_LEAK", { package: node.name });
  const framework = node.name.match(/(?:components-)?(react|svelte|solid)$/)?.[1];
  if (framework) for (const other of ["react", "svelte", "solid"]) if (other !== framework && new RegExp(`["'](?:${other === "solid" ? "solid-js" : other}|@mdfn/(?:components-)?${other})`).test(source)) fail("MDFN_GRAPH_FRAMEWORK_LEAK", { package: node.name, framework: other });
}

const visiting = new Set(); const visited = new Set();
function visit(name, trail = []) { if (visiting.has(name)) { fail("MDFN_GRAPH_CYCLE", { path: [...trail, name] }); return; } if (visited.has(name)) return; visiting.add(name); for (const dependency of dependencies.get(name) ?? []) visit(dependency, [...trail, name]); visiting.delete(name); visited.add(name); }
for (const name of nodeNames) visit(name);

const releases = JSON.parse(readFileSync(path.join(root, "release-packages.json"), "utf8"));
for (const node of nodes) if (!releases.some((entry) => entry.name === node.name && entry.path === node.path)) fail("MDFN_GRAPH_RELEASE_ROW_MISSING", { package: node.name });

if (failures.length) { console.error(JSON.stringify({ ok: false, failures }, null, 2)); process.exit(1); }
console.log(JSON.stringify({ ok: true, graphId: graph.graphId, stable: graph.stable.length, optional: graph.optional.length, frameworks: graph.frameworks }));
