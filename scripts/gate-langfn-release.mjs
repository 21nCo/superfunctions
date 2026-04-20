#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = process.cwd();
const RELEASE_GATE_COMMAND = "npm run gate:langfn-release";
const docsInventory = [
  "langfn/README.md",
  "langfn/SPEC.md",
  "langfn/COMPATIBILITY.md",
  "langfn/.conduct/release-gate.md",
  "langfn/typescript/README.md",
  "langfn/python/README.md"
];
const absolutePathPattern =
  /(^|[\s("'`])(?:\/Users\/[^\s"'`)\]]+|\/home\/[^\s"'`)\]]+|[A-Za-z]:\\Users\\[^\s"'`)\]]+)/m;

const nodeImportSmoke = `
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const distRoot = resolve(process.cwd(), "langfn/typescript/dist");
const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "langfn/typescript/package.json"), "utf8"));
const prompts = await import(pathToFileURL(resolve(distRoot, "prompts/index.js")).href);
const models = await import(pathToFileURL(resolve(distRoot, "models/index.js")).href);
const agents = await import(pathToFileURL(resolve(distRoot, "agents/index.js")).href);
const mcp = await import(pathToFileURL(resolve(distRoot, "mcp/index.js")).href);
const observability = await import(pathToFileURL(resolve(distRoot, "observability/index.js")).href);
if (!manifest.exports?.["."]) throw new Error("missing root export map entry");
if (!manifest.exports?.["./http"]) throw new Error("missing http export map entry");
if (!existsSync(resolve(distRoot, "index.js"))) throw new Error("missing built root entry");
if (!existsSync(resolve(distRoot, "http/index.js"))) throw new Error("missing built http entry");
if (typeof prompts.PromptTemplate !== "function") throw new Error("missing PromptTemplate export");
if (typeof models.OpenAIChatModel !== "function") throw new Error("missing OpenAIChatModel export");
if (typeof agents.ReActAgent !== "function") throw new Error("missing ReActAgent export");
if (typeof mcp.MCPServer !== "function") throw new Error("missing MCPServer export");
if (typeof observability.Tracer !== "function") throw new Error("missing Tracer export");
console.log("ok");
`;

const pythonImportSmoke = `
import sys
sys.path.insert(0, "packages/python-core")
sys.path.insert(0, "langfn/python")

from langfn import LangFn, create_http_routes
from langfn.prompts import PromptTemplate, ChatTemplate
from langfn.observability import Tracer, CostMeter, Budgets
from langfn.mcp import MCPClient, MCPServer

assert LangFn.__name__ == "LangFn"
assert create_http_routes is not None
assert PromptTemplate.__name__ == "PromptTemplate"
assert ChatTemplate.__name__ == "ChatTemplate"
assert Tracer.__name__ == "Tracer"
assert CostMeter.__name__ == "CostMeter"
assert Budgets.__name__ == "Budgets"
assert MCPClient.__name__ == "MCPClient"
assert MCPServer.__name__ == "MCPServer"
print("ok")
`;

const steps = [
  {
    name: "typescriptBuild",
    command: "npm",
    args: ["--prefix", "langfn/typescript", "run", "build"]
  },
  {
    name: "typescriptTests",
    command: "npm",
    args: ["--prefix", "langfn/typescript", "test"]
  },
  {
    name: "pythonTests",
    command: "python3",
    args: ["-m", "pytest", "langfn/python/tests", "-q"]
  },
  {
    name: "typescriptImportSmoke",
    command: process.execPath,
    args: ["--input-type=module", "-e", nodeImportSmoke]
  },
  {
    name: "pythonImportSmoke",
    command: "python3",
    args: ["-c", pythonImportSmoke]
  },
  {
    name: "typescriptSmokeSuites",
    command: "npm",
    args: [
      "--prefix",
      "langfn/typescript",
      "test",
      "--",
      "tests/http-routes.test.ts",
      "tests/mcp-and-eval.test.ts",
      "tests/streaming-observability.test.ts",
      "tests/release-gate.test.ts"
    ]
  },
  {
    name: "pythonSmokeSuites",
    command: "python3",
    args: [
      "-m",
      "pytest",
      "langfn/python/tests/test_http_routes.py",
      "langfn/python/tests/test_mcp_stdio.py",
      "langfn/python/tests/test_graph_and_eval_and_tracer.py",
      "langfn/python/tests/test_release_gate.py",
      "-q"
    ]
  },
  {
    name: "duplicationGate",
    command: process.execPath,
    args: ["scripts/check-duplication.mjs"]
  }
];

function runStep(step) {
  const result = spawnSync(step.command, step.args, {
    cwd: repoRoot,
    stdio: "pipe",
    encoding: "utf8",
    shell: false
  });

  return {
    name: step.name,
    command: [step.command, ...step.args].join(" "),
    ok: (result.status ?? 1) === 0,
    status: result.status ?? 1,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? ""
  };
}

function verifyDocsInventory() {
  const missingFiles = docsInventory.filter((file) => !existsSync(resolve(repoRoot, file)));
  const absolutePathMatches = [];
  const releaseCommandFiles = [];
  const compatibilityContent = existsSync(resolve(repoRoot, "langfn/COMPATIBILITY.md"))
    ? readFileSync(resolve(repoRoot, "langfn/COMPATIBILITY.md"), "utf8")
    : "";

  for (const file of docsInventory.filter((item) => existsSync(resolve(repoRoot, item)))) {
    const content = readFileSync(resolve(repoRoot, file), "utf8");
    if (absolutePathPattern.test(content)) {
      absolutePathMatches.push(file);
    }
    if (content.includes(RELEASE_GATE_COMMAND)) {
      releaseCommandFiles.push(file);
    }
  }

  const providerRowsPresent =
    ["openai", "anthropic", "ollama", "google", "mistral"].every((provider) =>
      compatibilityContent.includes(`| ${provider} |`)
    );

  return {
    ok:
      missingFiles.length === 0 &&
      absolutePathMatches.length === 0 &&
      releaseCommandFiles.length >= 2 &&
      providerRowsPresent,
    checkedFiles: docsInventory,
    missingFiles,
    absolutePathMatches,
    releaseCommandFiles,
    providerRowsPresent
  };
}

const stepResults = steps.map(runStep);
const docsResult = verifyDocsInventory();
const ok = stepResults.every((step) => step.ok) && docsResult.ok;
const payload = {
  ok,
  releaseGate: RELEASE_GATE_COMMAND,
  steps: stepResults.map(({ stdout, stderr, ...step }) => step),
  docsInventory: docsResult,
  productionReadyCondition:
    "Only a green npm run gate:langfn-release plus a passing compatibility matrix may be described as production-ready."
};

if (ok) {
  console.log(JSON.stringify(payload));
  process.exit(0);
}

console.error(
  JSON.stringify({
    ...payload,
    error: {
      code: "RELEASE_GATE_BLOCKED",
      failingSteps: stepResults.filter((step) => !step.ok).map((step) => step.name)
    }
  })
);
process.exit(1);
