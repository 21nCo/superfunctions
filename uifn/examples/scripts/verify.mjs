import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const examplesDir = path.resolve(scriptDir, "..");
const rootDir = path.resolve(examplesDir, "..", "..");
const checks = ["workspace", "manifest", "build", "docs", "offline"];

const workspaceDefinitions = [
  {
    name: "@uifn/examples",
    adapter: "hub",
    relPath: "uifn/examples",
    requiredScripts: ["dev:react", "dev:svelte", "dev:vue", "build", "verify"],
    notes: [],
  },
  {
    name: "@uifn/examples-shared",
    adapter: "shared",
    relPath: "uifn/examples/shared",
    requiredScripts: ["build"],
    notes: [],
  },
  {
    name: "@uifn/example-react-playground",
    adapter: "react",
    relPath: "uifn/examples/react-playground",
    requiredScripts: ["dev", "build", "preview"],
    notes: [],
    expectedPort: 6111,
  },
  {
    name: "@uifn/example-svelte-playground",
    adapter: "svelte",
    relPath: "uifn/examples/svelte-playground",
    requiredScripts: ["dev", "build", "preview"],
    notes: [],
    expectedPort: 6112,
  },
  {
    name: "@uifn/example-vue-playground",
    adapter: "vue",
    relPath: "uifn/examples/vue-playground",
    requiredScripts: ["dev", "build", "preview"],
    notes: ["experimental"],
    expectedPort: 6113,
  },
];

const result = {
  ok: true,
  command: "verify:uifn-examples",
  checks,
  workspaces: workspaceDefinitions.map(({ name, adapter, notes }) => ({
    name,
    adapter,
    ok: true,
    notes: [...notes],
  })),
  failures: [],
};

const workspaceResultByName = new Map(result.workspaces.map((entry) => [entry.name, entry]));

function markFailure(code, workspace, detail) {
  result.ok = false;
  const entry = workspaceResultByName.get(workspace);
  if (entry) {
    entry.ok = false;
  }
  result.failures.push({ code, workspace, detail });
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function readText(filePath) {
  return readFileSync(filePath, "utf8");
}

function run(command, args) {
  return spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function listFilesRecursively(startDir, accumulator = []) {
  for (const entry of readdirSync(startDir)) {
    if (entry === "node_modules" || entry === "dist") {
      continue;
    }
    const fullPath = path.join(startDir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      listFilesRecursively(fullPath, accumulator);
    } else {
      accumulator.push(fullPath);
    }
  }
  return accumulator;
}

const rootPackagePath = path.join(rootDir, "package.json");
const rootPackage = readJson(rootPackagePath);

if (!Array.isArray(rootPackage.workspaces) || !rootPackage.workspaces.includes("uifn/examples/*")) {
  markFailure(
    "EXAMPLE_WORKSPACE_MISSING",
    "@uifn/examples",
    "root package.json is missing workspace glob uifn/examples/*",
  );
}

for (const definition of workspaceDefinitions) {
  const pkgPath = path.join(rootDir, definition.relPath, "package.json");
  if (!existsSync(pkgPath)) {
    markFailure(
      "EXAMPLE_WORKSPACE_MISSING",
      definition.name,
      `missing workspace manifest at ${definition.relPath}/package.json`,
    );
    continue;
  }

  const pkg = readJson(pkgPath);
  if (pkg.name !== definition.name) {
    markFailure(
      "EXAMPLE_MANIFEST_INVALID",
      definition.name,
      `manifest name mismatch, expected ${definition.name}`,
    );
  }
  if (pkg.private !== true) {
    markFailure(
      "EXAMPLE_MANIFEST_INVALID",
      definition.name,
      "example workspaces must remain private",
    );
  }
  for (const scriptName of definition.requiredScripts) {
    if (!pkg.scripts || !pkg.scripts[scriptName]) {
      markFailure(
        "EXAMPLE_SCRIPT_MISSING",
        definition.name,
        `missing required script ${scriptName}`,
      );
    }
  }
  if (definition.expectedPort) {
    for (const scriptName of ["dev", "preview"]) {
      const scriptValue = pkg.scripts?.[scriptName] ?? "";
      if (!scriptValue.includes(`--port ${definition.expectedPort}`)) {
        markFailure(
          "EXAMPLE_MANIFEST_INVALID",
          definition.name,
          `script ${scriptName} must use fixed port ${definition.expectedPort}`,
        );
      }
    }
  }
}

const sharedScenariosPath = path.join(rootDir, "uifn/examples/shared/src/scenarios.ts");
const sharedCapabilitiesPath = path.join(rootDir, "uifn/examples/shared/src/capabilities.ts");
const sharedScenarioSource = readText(sharedScenariosPath);
const sharedCapabilitySource = readText(sharedCapabilitiesPath);

const scenarioIdMatches = [...sharedScenarioSource.matchAll(/id:\s*"([^"]+)"/g)].map((match) => match[1]);
const expectedScenarioIds = [
  "settings-console",
  "team-directory",
  "command-center",
  "virtualized-results",
];
if (JSON.stringify(scenarioIdMatches) !== JSON.stringify(expectedScenarioIds)) {
  markFailure(
    "EXAMPLE_SCENARIO_MISMATCH",
    "@uifn/examples-shared",
    "scenario ids/order drifted from canonical contract",
  );
}

if (!sharedScenarioSource.includes('defaultExampleRoute: ExampleRouteHash = "#/settings-console"')) {
  markFailure(
    "EXAMPLE_SCENARIO_MISMATCH",
    "@uifn/examples-shared",
    "default example route drifted from #/settings-console",
  );
}

for (const [adapter, port] of Object.entries({ react: 6111, svelte: 6112, vue: 6113 })) {
  if (!sharedScenarioSource.includes(`${adapter}: ${port}`)) {
    markFailure(
      "EXAMPLE_SCENARIO_MISMATCH",
      "@uifn/examples-shared",
      `fixed port for ${adapter} drifted from ${port}`,
    );
  }
}

if (
  !sharedCapabilitySource.includes('{ adapter: "react", capability: "virtualized-list", status: "supported" }') ||
  !sharedCapabilitySource.includes('{ adapter: "svelte", capability: "virtualized-list", status: "supported" }')
) {
  markFailure(
    "EXAMPLE_CAPABILITY_MISMATCH",
    "@uifn/examples-shared",
    "react and svelte must mark virtualized-list as supported",
  );
}

const vueVirtualizedSupportIsWrong =
  sharedCapabilitySource.includes('{ adapter: "vue", capability: "virtualized-list", status: "supported" }') ||
  !sharedCapabilitySource.includes('adapter: "vue"') ||
  !sharedCapabilitySource.includes('capability: "virtualized-list"') ||
  !sharedCapabilitySource.includes('status: "unsupported"') ||
  !sharedCapabilitySource.includes('note: vueVirtualizedListUnsupportedNote');

if (vueVirtualizedSupportIsWrong) {
  markFailure(
    "EXAMPLE_CAPABILITY_MISMATCH",
    "@uifn/example-vue-playground",
    "virtualized-list is marked supported but unsupported view is required",
  );
}

const appContractChecks = [
  {
    file: path.join(rootDir, "uifn/examples/react-playground/src/App.tsx"),
    workspace: "@uifn/example-react-playground",
    needles: ["normalizeExampleRoute", "VirtualizedList", "capabilitySupport"],
    detail: "React playground must consume shared routing and virtualized-list support",
  },
  {
    file: path.join(rootDir, "uifn/examples/svelte-playground/src/App.svelte"),
    workspace: "@uifn/example-svelte-playground",
    needles: ["normalizeExampleRoute", "capabilitySupport", "VirtualizedResultsScenario"],
    detail: "Svelte playground must consume shared routing and virtualized-list support",
  },
  {
    file: path.join(rootDir, "uifn/examples/vue-playground/src/App.vue"),
    workspace: "@uifn/example-vue-playground",
    needles: ["normalizeExampleRoute", "capabilitySupport", "Vue Experimental"],
    detail: "Vue playground must consume shared routing and retain experimental labeling",
  },
  {
    file: path.join(
      rootDir,
      "uifn/examples/vue-playground/src/scenarios/UnsupportedVirtualizedResultsScenario.vue",
    ),
    workspace: "@uifn/example-vue-playground",
    needles: ["vueVirtualizedListUnsupportedNote", 'data-mode="unsupported"'],
    detail: "Vue playground must render the canonical unsupported virtualized-results view",
  },
];

for (const check of appContractChecks) {
  const source = readText(check.file);
  for (const needle of check.needles) {
    if (!source.includes(needle)) {
      markFailure("EXAMPLE_SCENARIO_MISMATCH", check.workspace, check.detail);
      break;
    }
  }
}

for (const definition of workspaceDefinitions.slice(1)) {
  const build = run("npm", ["--workspace", definition.name, "run", "build"]);
  if (build.status !== 0) {
    const detail = (build.stderr || build.stdout || "vite build failed").trim().split("\n").at(-1);
    markFailure("EXAMPLE_BUILD_ERROR", definition.name, detail || "vite build failed");
  }
}

const docsChecks = [
  {
    file: path.join(rootDir, "uifn/README.md"),
    workspace: "@uifn/examples",
    needles: ["examples/README.md"],
    detail: "uifn README must link to the example hub",
  },
  {
    file: path.join(rootDir, "uifn/react/README.md"),
    workspace: "@uifn/example-react-playground",
    needles: ["react-playground"],
    detail: "React README must link to the React playground",
  },
  {
    file: path.join(rootDir, "uifn/svelte/README.md"),
    workspace: "@uifn/example-svelte-playground",
    needles: ["svelte-playground"],
    detail: "Svelte README must link to the Svelte playground",
  },
  {
    file: path.join(rootDir, "uifn/vue/README.md"),
    workspace: "@uifn/example-vue-playground",
    needles: ["vue-playground", "Experimental"],
    detail: "Vue README must link to the Vue playground and retain the experimental label",
  },
  {
    file: path.join(rootDir, "uifn/examples/README.md"),
    workspace: "@uifn/examples",
    needles: ["verify:uifn-examples", "6111", "6112", "6113"],
    detail: "examples hub README must document root commands and fixed ports",
  },
];

for (const check of docsChecks) {
  const source = readText(check.file);
  for (const needle of check.needles) {
    if (!source.includes(needle)) {
      markFailure("EXAMPLE_DOC_LINK_MISSING", check.workspace, check.detail);
      break;
    }
  }
}

const envFiles = listFilesRecursively(examplesDir).filter((filePath) =>
  path.basename(filePath).startsWith(".env"),
);
for (const envFile of envFiles) {
  markFailure(
    "EXAMPLE_ENV_FORBIDDEN",
    "@uifn/examples",
    `example workspaces must not require env files: ${path.relative(rootDir, envFile)}`,
  );
}

const offlinePatterns = [
  ["fe", "tch("].join(""),
  ["XML", "Http", "Request"].join(""),
  ["Web", "Socket("].join(""),
  ["navigator", ".", "sendBeacon"].join(""),
];
const scanFiles = listFilesRecursively(examplesDir).filter((filePath) =>
  [".ts", ".tsx", ".js", ".mjs", ".vue", ".svelte", ".md", ".json", ".html", ".css"].includes(
    path.extname(filePath),
  ),
);
for (const filePath of scanFiles) {
  const source = readText(filePath);
  for (const pattern of offlinePatterns) {
    if (source.includes(pattern)) {
      const workspace =
        filePath.includes("react-playground")
          ? "@uifn/example-react-playground"
          : filePath.includes("svelte-playground")
            ? "@uifn/example-svelte-playground"
            : filePath.includes("vue-playground")
              ? "@uifn/example-vue-playground"
              : "@uifn/examples";
      markFailure(
        "EXAMPLE_NETWORK_FORBIDDEN",
        workspace,
        `found forbidden network primitive ${pattern} in ${path.relative(rootDir, filePath)}`,
      );
      break;
    }
  }
}

const pretty = JSON.stringify(result, null, 2);
if (result.ok) {
  console.log(pretty);
  process.exit(0);
}

console.error(pretty);
process.exit(1);
