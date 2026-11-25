#!/usr/bin/env node
// Fails when the ownership manifests and the tree disagree. Public semantics: every tracked top-level directory
// and root file must be listed in superfunctions.owners.json, and the next manifest must not be tracked. Next
// semantics: an unlisted path is public-owned, so only superfunctions.owners.next.json entries are checked for
// existence. In both, every release slug and Python project must be listed (in either manifest on next), its path
// must be ownable and owned by the repository that publishes it, and every entry of the repository's own manifest
// (superfunctions.owners.json on public, superfunctions.owners.next.json on next) must exist. In both, every job of
// every workflow in .github/workflows outside SHARED_WORKFLOWS must carry the repository guard (D14); a reusable
// workflow's jobs may carry REUSABLE_WORKFLOW_GUARD instead, and a shared workflow's job with a job-level uses: must
// carry the guard unless it calls another shared workflow by its local path.
// Usage: node scripts/verify-owners.mjs [--repo public|next] [--root <checkout>]
// Without --repo, OWNERS_REPO selects the semantics; without either, the checkout decides (next when
// superfunctions.owners.next.json exists, public otherwise).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NEXT_MANIFEST, OwnersError, PUBLIC_MANIFEST, REPO_ROOT, REPOS, canonicalPythonName, loadOwners } from "./owners.mjs";
import { gitBinary } from "./verify-package-lockfiles.mjs";

export const RELEASE_FILES = Object.freeze({ public: "release-packages.json", next: "release-packages.next.json" });

export function trackedFiles(root) {
  return execFileSync(gitBinary(), ["ls-files", "-z"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    .split("\0")
    .filter(Boolean);
}

/** Reads release entries from release-packages.json and, on `next`, release-packages.next.json (D3). */
export function readReleaseEntries(root, repo) {
  const files = repo === "next" ? [RELEASE_FILES.public, RELEASE_FILES.next] : [RELEASE_FILES.public];
  const entries = [];
  for (const file of files) {
    const absolute = path.join(root, file);
    if (!existsSync(absolute)) {
      if (file === RELEASE_FILES.public) throw new OwnersError("manifest-not-found", `${file} not found`, { file });
      continue;
    }
    let data;
    try {
      data = JSON.parse(readFileSync(absolute, "utf8"));
    } catch (error) {
      throw new OwnersError("malformed-manifest", `${file}: invalid JSON: ${error.message}`, { file });
    }
    if (!Array.isArray(data)) throw new OwnersError("malformed-manifest", `${file}: expected an array`, { file });
    for (const [index, entry] of data.entries()) {
      if (!["slug", "path", "name"].every((field) => typeof entry?.[field] === "string" && entry[field] !== "")) {
        throw new OwnersError("malformed-manifest", `${file}: entry ${index} needs a non-empty slug, path and name`, { file, index });
      }
      entries.push({ slug: entry.slug, path: entry.path, name: entry.name, source: file });
    }
  }
  return entries;
}

// Workflows under .github/workflows are public-owned and synced to next (SFNS-121 D14). Every job of a workflow that
// is not on the shared list must skip outside the public repository, so `next` (whose CI runs on Depot) never runs it.
export const WORKFLOW_DIR = ".github/workflows";
export const REPOSITORY_GUARD = "github.repository == '21nCo/superfunctions'";
/** Workflows that run in both repositories (each repository publishes its own packages, D8). */
export const SHARED_WORKFLOWS = Object.freeze(["publish-tag.yml", "publish-python.yml"]);

const indentOf = (line) => line.length - line.trimStart().length;
const isContent = (line) => line.trim() !== "" && !line.trimStart().startsWith("#");

/** Index of the parenthesis that closes the one at `open`, skipping single-quoted expression strings; -1 if none. */
function closingParen(expression, open) {
  let depth = 0;
  for (let index = open; index < expression.length; index += 1) {
    const char = expression[index];
    if (char === "'") {
      index += 1;
      while (index < expression.length && !(expression[index] === "'" && expression[index + 1] !== "'")) {
        index += expression[index] === "'" ? 2 : 1;
      }
    } else if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return index;
  }
  return -1;
}

/**
 * A job `if:` expression without its `${{ }}` wrapper and with runs of whitespace collapsed to one space, or null when
 * `${{` or `}}` appears anywhere but a single wrapper around the whole value: GitHub then evaluates the value as a
 * string template, which is truthy, so no guard inside it holds.
 */
function normalizeCondition(condition) {
  let expression = condition.trim();
  const wrapped = expression.match(/^\$\{\{([\s\S]*)\}\}$/);
  if (wrapped) expression = wrapped[1].trim();
  if (expression.includes("${{") || expression.includes("}}")) return null;
  return expression.replaceAll(/\s+/g, " ");
}

const isTemplate = (condition) => normalizeCondition(condition) === null;

/**
 * Whether a job `if:` expression can only be true in the public repository: exactly the guard, or the guard joined
 * by `&&` to one parenthesised condition (so no top-level `||` can bypass it).
 */
export function hasRepositoryGuard(condition) {
  const expression = normalizeCondition(condition);
  if (expression === null) return false;
  if (expression === REPOSITORY_GUARD) return true;
  const prefix = `${REPOSITORY_GUARD} && (`;
  if (!expression.startsWith(prefix)) return false;
  return closingParen(expression, prefix.length - 1) === expression.length - 1;
}

/** Triggers a reusable workflow may have for the reusable guard to keep it from running on its own outside public. */
const REUSABLE_TRIGGERS = Object.freeze(["workflow_call", "workflow_dispatch"]);
/** Boolean input a reusable workflow declares under workflow_call only (default true), so its jobs can tell a call. */
export const REUSABLE_CALL_INPUT = "called_as_reusable_workflow";

/**
 * The guard for a job of a reusable workflow. A called workflow sees its caller's github context (repository,
 * event_name, workflow_ref), so the plain guard would skip it for every caller outside the public repository, including
 * the external repositories apifn documents, and no github field tells a call from a direct run. Its own inputs do:
 * REUSABLE_CALL_INPUT defaults to true under workflow_call and is not declared under workflow_dispatch, so every call
 * runs the job and a direct dispatch runs it only in the public repository. Callers are guarded on their own (every
 * in-repo caller carries the plain guard).
 */
export const REUSABLE_WORKFLOW_GUARD = `${REPOSITORY_GUARD} || inputs.${REUSABLE_CALL_INPUT} == true`;

/**
 * The same guard for a reusable workflow's job that must run whatever the result of the jobs it needs (so a failed or
 * cancelled job it depends on fails it instead of skipping it, and a skipped required check never passes). always() is
 * joined by `&&` to the parenthesised guard, so the job runs exactly when the guard holds; no other status form counts.
 */
export const REUSABLE_WORKFLOW_GUARD_ALWAYS = `always() && (${REUSABLE_WORKFLOW_GUARD})`;

/** Index of the first YAML comment (`#` at the start or after whitespace, outside an expression string) or -1. */
function commentAt(text) {
  let quoted = false;
  for (let char = 0; char < text.length; char += 1) {
    if (text[char] === "'") quoted = !quoted;
    else if (!quoted && text[char] === "#" && /\s/.test(text[char - 1] ?? " ")) return char;
  }
  return -1;
}

/**
 * Scalar value of a `key:` mapping entry at `lines[index]`, or null when it cannot be read reliably. A plain scalar
 * folds its deeper-indented continuation lines (as YAML does); quoted scalars spanning lines, comments inside a
 * multi-line plain scalar and flow, anchor, alias or tag forms fail closed.
 */
function readScalar(lines, index) {
  const indent = indentOf(lines[index]);
  const raw = lines[index].trimStart().replace(/^(['"]?)[^'":]+\1\s*:/, "").trim();
  let end = index + 1;
  while (end < lines.length && (lines[end].trim() === "" || indentOf(lines[end]) > indent)) end += 1;
  const continuation = lines.slice(index + 1, end).map((line) => line.trim()).filter((line) => line !== "");
  if (/^[>|](?:[+-]\d?|\d[+-]?)?\s*(?:#.*)?$/.test(raw)) return continuation.join(" ");
  if (/^[&*![{]/.test(raw)) return null;
  if (raw.startsWith("'") || raw.startsWith('"')) {
    if (continuation.length > 0) return null;
    if (raw.startsWith("'")) {
      const match = raw.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
      return match ? match[1].replaceAll("''", "'") : null;
    }
    const match = raw.match(/^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/);
    return match ? JSON.parse(`"${match[1]}"`) : null;
  }
  const comment = commentAt(raw);
  if (comment !== -1 && continuation.length > 0) return null;
  if (continuation.some((line) => commentAt(line) !== -1)) return null;
  return [comment === -1 ? raw : raw.slice(0, comment).trim(), ...continuation].filter((part) => part !== "").join(" ");
}

/** A block mapping key: an identifier, plain or quoted (no escapes), followed by `:` and a space or the line end. */
const MAPPING_KEY = /^(?:([A-Za-z_][A-Za-z0-9_-]*)|'([A-Za-z_][A-Za-z0-9_-]*)'|"([A-Za-z_][A-Za-z0-9_-]*)")[ \t]*:(?=\s|$)/;

/** The key of the mapping entry at `line`, or null when it is not a key MAPPING_KEY models. */
function mappingKey(line) {
  const match = line.trim().match(MAPPING_KEY);
  return match ? (match[1] ?? match[2] ?? match[3]) : null;
}

/**
 * Entries ({ key, index }) of the block mapping that is the value of the `key:` line at `lines[at]`, or null when it
 * cannot be read reliably: an inline value other than `{}`, a key MAPPING_KEY does not model, a duplicate key or an
 * entry indented less than the first one.
 */
function blockEntries(lines, at) {
  const inline = lines[at].trim().replace(MAPPING_KEY, "");
  const comment = commentAt(inline);
  const value = (comment === -1 ? inline : inline.slice(0, comment)).trim();
  if (value === "{}") return [];
  if (value !== "") return null;
  const parent = indentOf(lines[at]);
  const entries = [];
  let childIndent = null;
  for (let index = at + 1; index < lines.length; index += 1) {
    if (!isContent(lines[index])) continue;
    const indent = indentOf(lines[index]);
    if (indent <= parent) break;
    childIndent ??= indent;
    if (indent > childIndent) continue;
    if (indent < childIndent) return null;
    const key = mappingKey(lines[index]);
    if (key === null || entries.some((entry) => entry.key === key)) return null;
    entries.push({ key, index });
  }
  return entries;
}

/**
 * Inputs a trigger of the workflow declares under its block-style top-level `on:` key, as a Map from input name to
 * its scalar fields (type, default, required); an empty Map when the trigger declares none, or null when the trigger
 * is missing or its inputs cannot be read reliably.
 */
export function workflowInputs(source, trigger) {
  const lines = source.split(/\r?\n/);
  const at = lines.findIndex((line) => /^(['"]?)on\1\s*:/.test(line));
  if (at === -1) return null;
  const entry = blockEntries(lines, at)?.find(({ key }) => key === trigger);
  if (!entry) return null;
  const properties = blockEntries(lines, entry.index);
  if (properties === null) return null;
  const inputs = new Map();
  const declared = properties.find(({ key }) => key === "inputs");
  if (!declared) return inputs;
  const declaredInputs = blockEntries(lines, declared.index);
  if (declaredInputs === null) return null;
  for (const input of declaredInputs) {
    const fields = blockEntries(lines, input.index);
    if (fields === null) return null;
    const values = {};
    for (const field of fields.filter(({ key }) => ["type", "default", "required"].includes(key))) {
      values[field.key] = readScalar(lines, field.index);
      if (values[field.key] === null) return null;
    }
    inputs.set(input.key, values);
  }
  return inputs;
}

/** Entries of an inputs Map whose name is REUSABLE_CALL_INPUT in any letter case (GitHub resolves inputs that way). */
function markerInputs(inputs) {
  return [...(inputs ?? [])].filter(([name]) => name.toLowerCase() === REUSABLE_CALL_INPUT);
}

/**
 * Why the workflow may not carry REUSABLE_WORKFLOW_GUARD, or null when it may: it must be triggered only by
 * workflow_call (and optionally workflow_dispatch), declare REUSABLE_CALL_INPUT under workflow_call as an optional
 * boolean defaulting to true, and not declare it under workflow_dispatch. Input names are matched case-insensitively,
 * as GitHub's inputs context is, so a case alias of the marker counts as the marker.
 */
function reusableGuardError(source) {
  const triggers = workflowTriggers(source);
  if (triggers === null || !triggers.includes("workflow_call") || !triggers.every((name) => REUSABLE_TRIGGERS.includes(name))) {
    return `the workflow is not triggered only by ${REUSABLE_TRIGGERS.join(" and ")} (triggers: ${triggers === null ? "unreadable" : triggers.join(", ")})`;
  }
  const markers = markerInputs(workflowInputs(source, "workflow_call"));
  const marker = markers.length === 1 ? markers[0][1] : undefined;
  if (marker?.type !== "boolean" || marker.default !== "true" || (marker.required ?? "false") !== "false") {
    return `workflow_call does not declare the input ${REUSABLE_CALL_INPUT} with type: boolean, default: true and required: false`;
  }
  if (!triggers.includes("workflow_dispatch")) return null;
  const dispatch = workflowInputs(source, "workflow_dispatch");
  if (dispatch === null) return "its workflow_dispatch inputs cannot be read";
  const aliases = markerInputs(dispatch).map(([name]) => name);
  if (aliases.length > 0) {
    return `workflow_dispatch also declares ${aliases.join(", ")} (inputs are case-insensitive, so it is ${REUSABLE_CALL_INPUT}), so a direct dispatch would run outside public`;
  }
  return null;
}

/** Names of the workflow's triggers from its top-level `on:` key, or null when they cannot be read reliably. */
export function workflowTriggers(source) {
  const lines = source.split(/\r?\n/);
  const at = lines.findIndex((line) => /^(['"]?)on\1\s*:/.test(line));
  if (at === -1) return null;
  const inline = lines[at].replace(/^(['"]?)on\1\s*:/, "");
  const value = (commentAt(inline) === -1 ? inline : inline.slice(0, commentAt(inline))).trim();
  if (/^[A-Za-z_]+$/.test(value)) return [value];
  const flow = value.match(/^\[([A-Za-z_,\s]*)\]$/);
  if (flow) return flow[1].split(",").map((name) => name.trim()).filter((name) => name !== "");
  if (value !== "") return null;
  const triggers = [];
  let childIndent = null;
  for (let index = at + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!isContent(line)) continue;
    const indent = indentOf(line);
    if (indent === 0) break;
    childIndent ??= indent;
    if (indent > childIndent) continue;
    if (indent < childIndent) return null;
    const name = line.trim().match(/^(?:-\s+)?(['"]?)([A-Za-z_]+)\1\s*(?::\s*(?:[^\s#].*)?|(?:#.*)?)$/);
    if (!name) return null;
    triggers.push(name[2]);
  }
  return triggers.length > 0 ? triggers : null;
}

/** Jobs of a workflow from its block-style top-level `jobs:` key: { jobs: [{ name, condition, uses }] } or { error }. */
function readJobs(file, lines) {
  const jobsAt = lines.findIndex((line) => /^jobs:\s*(?:#.*)?$/.test(line));
  if (jobsAt === -1) return { error: `${file}: has no block-style top-level jobs: key, so its repository guard cannot be checked` };
  const jobs = [];
  let jobIndent = null;
  let job = null;
  for (let index = jobsAt + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!isContent(line)) continue;
    const indent = indentOf(line);
    if (indent === 0) break;
    jobIndent ??= indent;
    if (indent < jobIndent) return { error: `${file}: line ${index + 1} is indented less than the jobs it follows` };
    if (indent === jobIndent) {
      const header = line.trim().match(/^(['"]?)([A-Za-z_][A-Za-z0-9_-]*)\1:\s*(?:#.*)?$/);
      if (!header) return { error: `${file}: line ${index + 1} is not a block-style job key, so its repository guard cannot be checked` };
      job = { name: header[2], propertyIndent: null, condition: undefined, uses: undefined };
      jobs.push(job);
      continue;
    }
    job.propertyIndent ??= indent;
    if (indent > job.propertyIndent) continue;
    if (indent < job.propertyIndent) return { error: `${file}: line ${index + 1} is indented less than the job properties it follows` };
    const key = mappingKey(line);
    if (key === null) return { error: `${file}: line ${index + 1} is not a job property key the reader can follow, so its repository guard cannot be checked` };
    if (key !== "if" && key !== "uses") continue;
    const property = key === "if" ? "condition" : "uses";
    if (job[property] !== undefined) return { error: `${file}: job "${job.name}" has more than one ${key}: key` };
    const value = readScalar(lines, index);
    if (value === null) return { error: `${file}: line ${index + 1} has a${key === "if" ? "n" : ""} ${key}: value that cannot be read` };
    job[property] = value;
  }
  if (jobs.length === 0) return { error: `${file}: jobs: has no jobs, so its repository guard cannot be checked` };
  return { jobs };
}

const guardHint = `jobs outside the shared list must start their if: with ${REPOSITORY_GUARD}`;
function describeCondition(condition) {
  if (condition === undefined) return "has no if:";
  const template = isTemplate(condition) ? " (a ${{ }} that does not wrap the whole value makes GitHub read it as an always-true string)" : "";
  return `has if: ${JSON.stringify(condition)}${template}`;
}

/**
 * Whether a job-level `uses:` calls a shared workflow by its local `./.github/workflows/<shared>.yml` path, the only
 * reusable-workflow call a shared workflow's job may make without the repository guard. Any other call (another local
 * workflow, this repository under any of its names or aliases, its next fork, any owner/repo/...@ref or an expression)
 * may run a guarded workflow's jobs on next or a fork through the call-only input, so it is not exempt.
 */
function callsSharedWorkflowLocally(uses) {
  const local = uses.match(/^\.\/\.github\/workflows\/([A-Za-z0-9_.-]+\.ya?ml)$/);
  return local !== null && SHARED_WORKFLOWS.includes(local[1]);
}

/**
 * Errors for one workflow file. Outside the shared list every job must carry the repository guard in its `if:`; a job
 * of a reusable workflow may carry REUSABLE_WORKFLOW_GUARD or REUSABLE_WORKFLOW_GUARD_ALWAYS instead when
 * reusableGuardError accepts the workflow. On the shared list every job with a job-level `uses:` must carry the guard
 * unless it calls another shared workflow by its local `./.github/workflows/<shared>.yml` path (an allow-list), so no
 * reusable workflow runs on next through a shared caller. An `if:` with a `${{ }}` that does not wrap its whole value never counts as guarded.
 * Workflows are read line by line (block style, as every workflow here is written); a layout or key the reader does
 * not model fails closed.
 */
export function workflowGuardErrors(file, source) {
  const lines = source.split(/\r?\n/);
  const read = readJobs(file, lines);
  if (read.error) return [read.error];
  const shared = SHARED_WORKFLOWS.includes(path.posix.basename(file));
  const errors = [];
  for (const { name, condition, uses } of read.jobs) {
    if (condition !== undefined && hasRepositoryGuard(condition)) continue;
    const normalized = condition === undefined ? null : normalizeCondition(condition);
    if (normalized === REUSABLE_WORKFLOW_GUARD || normalized === REUSABLE_WORKFLOW_GUARD_ALWAYS) {
      const reason = reusableGuardError(source);
      if (reason !== null) errors.push(`${file}: job "${name}" carries the reusable-workflow guard, but ${reason}`);
      continue;
    }
    if (!shared) {
      errors.push(`${file}: job "${name}" ${describeCondition(condition)}; ${guardHint}`);
      continue;
    }
    if (uses !== undefined && !callsSharedWorkflowLocally(uses)) {
      errors.push(`${file}: job "${name}" has uses: ${JSON.stringify(uses)} and ${describeCondition(condition)}; a shared workflow's job with uses: must start its if: with ${REPOSITORY_GUARD} unless it calls a shared workflow by its ./${WORKFLOW_DIR}/<file> path`);
    }
  }
  return errors;
}

/** Repository-guard errors for every tracked workflow (shared workflows are checked only for their callers). */
export function findWorkflowGuardErrors(workflows) {
  return workflows.flatMap(({ file, source }) => workflowGuardErrors(file, source));
}

/** Tracked workflow files directly under .github/workflows, with their contents. */
export function readWorkflows(root, files) {
  return files
    .filter((file) => path.posix.dirname(file) === WORKFLOW_DIR && /\.ya?ml$/.test(file))
    .sort(compareStrings)
    .map((file) => ({ file, source: readFileSync(path.join(root, file), "utf8") }));
}

/** Throws the typed error for a pyproject.toml whose project metadata cannot be read reliably. */
function unreadable(file, line, reason) {
  return new OwnersError("unreadable-pyproject", `${file}${line ? `:${line}` : ""}: ${reason}`, { file, line });
}

const BASIC_ESCAPES = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\x1b", '"': '"', "\\": "\\" };

/**
 * Decodes the escapes of a basic string (TOML 1.0 plus the 1.1 \e and \xHH escapes); in a multi-line basic
 * string a line-ending backslash trims whitespace.
 */
function unescapeBasic(raw, multiline, fail) {
  return raw.replace(/\\([ \t]*\n[ \t\n]*|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[\s\S])/g, (_, escape) => {
    if (multiline && escape.includes("\n")) return "";
    if (/^x[0-9A-Fa-f]{2}$/.test(escape)) return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
    if (/^[uU][0-9A-Fa-f]+$/.test(escape) && escape.length > 1) {
      const codePoint = Number.parseInt(escape.slice(1), 16);
      if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) throw fail(`invalid escape \\${escape}`);
      return String.fromCodePoint(codePoint);
    }
    if (Object.hasOwn(BASIC_ESCAPES, escape)) return BASIC_ESCAPES[escape];
    throw fail(`invalid escape \\${escape.trimEnd()}`);
  });
}

/** An integer, float, boolean, date or time value; only strings and tables matter to the ownership check. */
class TomlScalar {
  constructor(text) {
    this.text = text;
  }
}

const SCALARS = [
  /\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?/y,
  /\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?/y,
  /true|false|[+-]?(?:inf|nan|0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|[0-9_]+(?:\.[0-9_]+)?(?:[eE][+-]?[0-9_]+)?)/y,
];

/**
 * Parses a TOML document into plain objects (tables are null-prototype objects, arrays are arrays, strings are
 * strings, other values are TomlScalar). It covers TOML 1.0 plus the TOML 1.1 changes: the \e and \xHH escapes,
 * newlines, trailing commas and comments inside inline tables, and times and datetimes without seconds. Only strings,
 * keys and the table structure are decoded exactly; other scalars are matched loosely and kept as text, so some
 * invalid TOML is accepted: number underscores and leading zeros are not validated (0x_ff, 1__2, 007, even a bare _),
 * date and time fields are not range-checked, and a leading byte order mark is skipped. Redefining a key or table
 * fails, as TOML requires. `onHeader` sees every
 * table header before it is applied. Errors come from `fail(line, reason)`. Returns the document and the line on
 * which each key path was first defined.
 */
export function parseToml(source, { fail, onHeader = () => {} }) {
  const text = source.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const newlines = [];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) newlines.push(index);
  const lineAt = (at) => {
    let low = 0;
    let high = newlines.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (newlines[middle] < at) low = middle + 1;
      else high = middle;
    }
    return low + 1;
  };
  let pos = 0;
  const error = (reason, at = pos) => fail(lineAt(at), reason);
  const lineText = (at) => text.slice(text.lastIndexOf("\n", at - 1) + 1, (text.indexOf("\n", at) + 1 || text.length + 1) - 1).trim();

  // Table kinds: "implicit" (only named by a longer header), "header", "dotted" (made by a dotted key) and
  // "inline" (an inline table and the dotted tables inside it, which are closed once written).
  const kinds = new WeakMap();
  const arraysOfTables = new WeakSet();
  const lines = new Map();
  const newTable = (kind) => {
    const table = Object.create(null);
    kinds.set(table, kind);
    return table;
  };
  const isTable = (value) => typeof value === "object" && value !== null && kinds.has(value);
  const display = (segments) => segments.map((segment) => (/^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment))).join(".");
  const record = (segments, at) => {
    const key = JSON.stringify(segments);
    if (!lines.has(key)) lines.set(key, lineAt(at));
  };
  const redefined = (segments, at) => error(`${display(segments)} is defined more than once`, at);

  const skipSpace = () => {
    while (text[pos] === " " || text[pos] === "\t") pos += 1;
  };
  const skipComment = () => {
    if (text[pos] === "#") {
      const end = text.indexOf("\n", pos);
      pos = end === -1 ? text.length : end;
    }
  };
  const skipBlank = () => {
    for (;;) {
      skipSpace();
      skipComment();
      if (text[pos] !== "\n") return;
      pos += 1;
    }
  };
  const endOfLine = (what) => {
    skipSpace();
    skipComment();
    if (pos < text.length && text[pos] !== "\n") throw error(`unexpected text after ${what}`);
    pos += 1;
  };

  const matchAt = (pattern) => {
    pattern.lastIndex = pos;
    const match = pattern.exec(text);
    if (match) pos += match[0].length;
    return match;
  };

  const readMultiline = (delimiter) => {
    const start = pos;
    pos += 3;
    if (text[pos] === "\n") pos += 1;
    const bodyStart = pos;
    for (let index = pos; index < text.length; index += 1) {
      if (delimiter === '"""' && text[index] === "\\") {
        index += 1;
      } else if (text.startsWith(delimiter, index)) {
        // Up to two quotes directly before the closing delimiter belong to the string.
        let end = index;
        while (end < index + 2 && text[end + 3] === delimiter[0]) end += 1;
        pos = end + 3;
        const raw = text.slice(bodyStart, end);
        return delimiter === "'''" ? raw : unescapeBasic(raw, true, (reason) => error(reason, start));
      }
    }
    throw error("unterminated multi-line string", start);
  };

  const readString = () => {
    const start = pos;
    if (text.startsWith('"""', pos)) return readMultiline('"""');
    if (text.startsWith("'''", pos)) return readMultiline("'''");
    let match = matchAt(/"((?:[^"\\\n]|\\.)*)"/y);
    if (match) return unescapeBasic(match[1], false, (reason) => error(reason, start));
    match = matchAt(/'([^'\n]*)'/y);
    if (match) return match[1];
    throw error("unterminated string", start);
  };

  const readKey = () => {
    const segments = [];
    for (;;) {
      skipSpace();
      if (text[pos] === '"' || text[pos] === "'") {
        if (text.startsWith('"""', pos) || text.startsWith("'''", pos)) throw error("a key cannot be a multi-line string");
        segments.push(readString());
      } else {
        const match = matchAt(/[A-Za-z0-9_-]+/y);
        if (!match) throw error(`cannot read key in ${lineText(pos)}`);
        segments.push(match[0]);
      }
      skipSpace();
      if (text[pos] !== ".") return segments;
      pos += 1;
    }
  };

  // Writes `value` at the dotted key `segments` below `table` (whose path is `base`).
  const assign = (table, base, segments, value, at, dottedKind) => {
    let target = table;
    for (const [index, segment] of segments.slice(0, -1).entries()) {
      const pathSoFar = [...base, ...segments.slice(0, index + 1)];
      if (!Object.hasOwn(target, segment)) {
        target[segment] = newTable(dottedKind);
        record(pathSoFar, at);
      } else if (isTable(target[segment]) && kinds.get(target[segment]) === "implicit") {
        // A table only named by a longer header may be extended by dotted keys, and is then closed to headers.
        kinds.set(target[segment], dottedKind);
      } else if (!isTable(target[segment]) || kinds.get(target[segment]) !== dottedKind) {
        throw redefined(pathSoFar, at);
      }
      target = target[segment];
    }
    const last = segments.at(-1);
    if (Object.hasOwn(target, last)) throw redefined([...base, ...segments], at);
    target[last] = value;
    record([...base, ...segments], at);
  };

  const readValue = (valuePath) => {
    const start = pos;
    const char = text[pos];
    if (char === '"' || char === "'") return readString();
    if (char === "[") {
      pos += 1;
      const array = [];
      for (;;) {
        skipBlank();
        if (text[pos] === "]") break;
        array.push(readValue([...valuePath, String(array.length)]));
        skipBlank();
        if (text[pos] === ",") pos += 1;
        else if (text[pos] !== "]") throw error("expected , or ] in array", pos < text.length ? pos : start);
      }
      pos += 1;
      return array;
    }
    if (char === "{") {
      // Newlines and a trailing comma are accepted (TOML 1.1).
      pos += 1;
      const table = newTable("inline");
      for (;;) {
        skipBlank();
        if (text[pos] === "}") break;
        const at = pos;
        const segments = readKey();
        if (text[pos] !== "=") throw error(`expected = after key in inline table`);
        pos += 1;
        skipSpace();
        assign(table, valuePath, segments, readValue([...valuePath, ...segments]), at, "inline");
        skipBlank();
        if (text[pos] === ",") pos += 1;
        else if (text[pos] !== "}") throw error("expected , or } in inline table", pos < text.length ? pos : start);
      }
      pos += 1;
      return table;
    }
    for (const pattern of SCALARS) {
      const match = matchAt(pattern);
      if (match && match[0] !== "") return new TomlScalar(match[0]);
    }
    throw error(`cannot read value in ${lineText(start)}`, start);
  };

  const root = newTable("header");
  let current = root;
  let currentPath = [];
  for (;;) {
    skipBlank();
    if (pos >= text.length) break;
    const at = pos;
    if (text[pos] === "[") {
      const isArray = text.startsWith("[[", pos);
      pos += isArray ? 2 : 1;
      const headerFail = () => error(`cannot read table header ${lineText(at)}`, at);
      let segments;
      try {
        segments = readKey();
      } catch {
        throw headerFail();
      }
      const close = isArray ? "]]" : "]";
      if (!text.startsWith(close, pos)) throw headerFail();
      pos += close.length;
      endOfLine("table header");
      onHeader(segments, isArray, lineAt(at));
      let table = root;
      for (const [index, segment] of segments.slice(0, -1).entries()) {
        const pathSoFar = segments.slice(0, index + 1);
        if (!Object.hasOwn(table, segment)) {
          table[segment] = newTable("implicit");
          record(pathSoFar, at);
        }
        const next = table[segment];
        if (arraysOfTables.has(next)) table = next.at(-1);
        else if (isTable(next) && kinds.get(next) !== "inline") table = next;
        else throw redefined(pathSoFar, at);
      }
      const last = segments.at(-1);
      if (isArray) {
        if (!Object.hasOwn(table, last)) {
          table[last] = [];
          arraysOfTables.add(table[last]);
          record(segments, at);
        } else if (!arraysOfTables.has(table[last])) {
          throw redefined(segments, at);
        }
        current = newTable("header");
        table[last].push(current);
      } else {
        if (!Object.hasOwn(table, last)) {
          table[last] = newTable("header");
          record(segments, at);
        } else if (!isTable(table[last]) || kinds.get(table[last]) !== "implicit") {
          throw redefined(segments, at);
        }
        current = table[last];
        kinds.set(current, "header");
      }
      currentPath = segments;
      continue;
    }
    const segments = readKey();
    if (text[pos] !== "=") throw error(`cannot read key/value line ${lineText(at)}`, at);
    pos += 1;
    skipSpace();
    const value = readValue([...currentPath, ...segments]);
    assign(current, currentPath, segments, value, at, "dotted");
    endOfLine("value");
  }
  return { document: root, lineOf: (segments) => lines.get(JSON.stringify(segments)) ?? 0 };
}

/**
 * Name of the project a pyproject.toml declares (`project.name`, in any valid TOML spelling: a [project] table,
 * dotted keys, an inline table, any string kind), or null when it declares no project. Fails closed with an
 * `unreadable-pyproject` OwnersError naming the file when the file is not valid TOML or declares project
 * metadata whose name cannot be read.
 */
export function pyprojectName(source, file = "pyproject.toml") {
  const { document, lineOf } = parseToml(source, {
    fail: (line, reason) => unreadable(file, line, reason),
    onHeader: (segments, isArray, line) => {
      if (isArray && segments.length === 1 && segments[0] === "project") {
        throw unreadable(file, line, "project metadata must not be an array of tables");
      }
    },
  });
  if (!Object.hasOwn(document, "project")) return null;
  const project = document.project;
  if (typeof project !== "object" || project === null || Array.isArray(project) || project instanceof TomlScalar) {
    throw unreadable(file, lineOf(["project"]), "project metadata must be a table");
  }
  if (!Object.hasOwn(project, "name")) throw unreadable(file, 0, "project metadata has no name");
  const name = project.name;
  const line = lineOf(["project", "name"]);
  if (typeof name !== "string") throw unreadable(file, line, "project name must be a string");
  if (name === "") throw unreadable(file, line, "project name is empty");
  if (/[\r\n]/.test(name)) throw unreadable(file, line, "project name must not contain a line break");
  return name;
}

export function readPythonProjects(root, files) {
  return files
    .filter((file) => path.posix.basename(file) === "pyproject.toml")
    .sort()
    .flatMap((file) => {
      const name = pyprojectName(readFileSync(path.join(root, file), "utf8"), file);
      return name === null ? [] : [{ name, file }];
    });
}

/** Code-unit order, the same order as Array.prototype.sort without a comparator. */
function compareStrings(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Runs an ownership lookup; an OwnersError becomes null, so every caller must report a null result. */
function tryOwner(lookup) {
  try {
    return lookup();
  } catch (error) {
    if (error instanceof OwnersError) return null;
    throw error;
  }
}

/**
 * Owner of a release or Python project path under `repo`. A path that cannot be owned (absolute, leaving the
 * repository, or under a top-level directory public does not list) is reported, naming the path and the entry.
 */
function ownerOfEntryPath(owners, repo, target, label, errors) {
  try {
    return owners.ownerOfPath(target, { repo });
  } catch (error) {
    if (!(error instanceof OwnersError)) throw error;
    errors.push(`${target}: ${label} has a path that cannot be owned (${error.code}): ${error.message}`);
    return null;
  }
}

/** Names where a release slug that already has an entry in `first` is listed again. */
function duplicateSources(first, source) {
  return first === source ? `more than once in ${source}` : `in both ${first} and ${source}`;
}

/**
 * Records the entry's slug and npm name, or returns the error when another entry already has either: one
 * published package has exactly one release entry (scripts/resolve-release-tag.mjs also requires unique names).
 */
function duplicateEntryError(entry, bySlug, byName) {
  const slug = JSON.stringify(entry.slug);
  const sameSlug = bySlug.get(entry.slug);
  if (sameSlug) return `${entry.path}: release ${slug} is listed ${duplicateSources(sameSlug.source, entry.source)}; a release has exactly one entry`;
  bySlug.set(entry.slug, entry);
  const sameName = byName.get(entry.name);
  if (!sameName) {
    byName.set(entry.name, entry);
    return null;
  }
  const other = `release ${JSON.stringify(sameName.slug)} from ${sameName.source}`;
  return `${entry.path}: release ${slug} from ${entry.source} has npm name ${JSON.stringify(entry.name)}, which ${other} also has; a package has exactly one release entry`;
}

/** Errors for one release entry's publisher: listed in the manifests, in its publisher's file, under a path it owns. */
function releaseOwnerErrors({ owners, repo, listedIn }, entry, errors) {
  const slug = JSON.stringify(entry.slug);
  const owner = tryOwner(() => owners.ownerOfRelease(entry.slug, { repo }));
  if (owner === null) {
    errors.push(`${entry.path}: release ${slug} from ${entry.source} is not listed in the releases of ${listedIn}`);
  } else if (entry.source !== RELEASE_FILES[owner]) {
    errors.push(`${entry.path}: release ${slug} is ${owner}-published but listed in ${entry.source}; it belongs in ${RELEASE_FILES[owner]}`);
  }
  const pathOwner = ownerOfEntryPath(owners, repo, entry.path, `release ${slug} from ${entry.source}`, errors);
  if (owner !== null && pathOwner !== null && pathOwner !== owner) {
    errors.push(`${entry.path}: release ${slug} is ${owner}-published but its path is ${pathOwner}-owned`);
  }
}

/**
 * Release entries: each slug and each npm name has exactly one entry, in the release file of the repository that
 * publishes it (release-packages.json for public, release-packages.next.json for next), and is listed in the
 * manifests with a path its publisher owns. Listed slugs without an entry are stale.
 */
function findReleaseErrors({ owners, repo, releases, listed }, errors) {
  const listedIn = repo === "next" && owners.nextManifest ? `${PUBLIC_MANIFEST} or ${NEXT_MANIFEST}` : PUBLIC_MANIFEST;
  const bySlug = new Map();
  const byName = new Map();
  for (const entry of releases) {
    const duplicate = duplicateEntryError(entry, bySlug, byName);
    if (duplicate) errors.push(duplicate);
    releaseOwnerErrors({ owners, repo, listedIn }, entry, errors);
  }
  const stale = listed ? [...listed.releases.keys()].filter((slug) => !bySlug.has(slug)) : [];
  for (const slug of stale) errors.push(`${listed.file}: release ${JSON.stringify(slug)} has no entry in the release files`);
}

/**
 * Compares the manifests with a tree. Returns one message per disagreement, each naming the path or entry.
 * @param {{ owners: ReturnType<typeof loadOwners>, repo: "public" | "next", files: string[], releases: {slug: string, path: string, name: string, source: string}[], python: {name: string, file: string}[] }} input
 */
export function findOwnershipErrors({ owners, repo, files, releases, python }) {
  const errors = [];
  const { publicManifest, nextManifest } = owners;
  const dirs = new Set();
  const rootFiles = new Set();
  for (const file of files) {
    const slash = file.indexOf("/");
    if (slash === -1) rootFiles.add(file);
    else dirs.add(file.slice(0, slash));
  }

  if (repo === "public" && files.includes(NEXT_MANIFEST)) {
    errors.push(`${NEXT_MANIFEST}: exists only on next and must not be tracked in the public repository`);
  }

  for (const dir of [...dirs].sort(compareStrings)) {
    if (repo === "public" && !publicManifest.paths.has(dir)) {
      errors.push(`${dir}/: top-level directory is not listed in ${PUBLIC_MANIFEST} paths`);
    }
  }
  for (const file of [...rootFiles].sort(compareStrings)) {
    if (repo === "public" && !publicManifest.rootFiles.has(file)) {
      errors.push(`${file}: root file is not listed in ${PUBLIC_MANIFEST} rootFiles`);
    }
  }

  // Listed entries must exist in this repository's tree. Generated root files are regenerated per repository
  // and may be absent; on `next` the public entries are checked by the sync, not here.
  const listed = repo === "public" ? publicManifest : nextManifest;
  if (listed) {
    for (const dir of listed.paths.keys()) {
      if (!dirs.has(dir)) errors.push(`${dir}/: listed in ${listed.file} paths but is not a tracked top-level directory`);
    }
    for (const [file, rootClass] of listed.rootFiles) {
      if (rootClass !== "generated" && !rootFiles.has(file)) {
        errors.push(`${file}: listed in ${listed.file} rootFiles.${rootClass} but is not a tracked root file`);
      }
    }
  }

  findReleaseErrors({ owners, repo, releases, listed }, errors);

  // Python projects are matched by their PEP 503 canonical name, so two spellings of one distribution collide.
  const projects = new Map();
  for (const project of python) {
    const id = canonicalPythonName(project.name);
    const first = projects.get(id);
    if (first) {
      errors.push(`${project.file}: Python project ${JSON.stringify(project.name)} is also defined by ${first.file} (as ${JSON.stringify(first.name)}); a project needs exactly one pyproject.toml`);
      continue;
    }
    projects.set(id, project);
    const owner = tryOwner(() => owners.ownerOfPython(project.name, { repo }));
    if (owner === null) {
      errors.push(`${project.file}: Python project ${JSON.stringify(project.name)} is not listed in the python entries of ${repo === "next" && nextManifest ? `${PUBLIC_MANIFEST} or ${NEXT_MANIFEST}` : PUBLIC_MANIFEST}`);
    }
    const pathOwner = ownerOfEntryPath(owners, repo, project.file, `Python project ${JSON.stringify(project.name)}`, errors);
    if (owner !== null && pathOwner !== null && pathOwner !== owner) {
      errors.push(`${project.file}: Python project ${JSON.stringify(project.name)} is ${owner}-published but its path is ${pathOwner}-owned`);
    }
  }
  if (listed) {
    for (const [id, name] of listed.pythonNames) {
      if (!projects.has(id)) errors.push(`${listed.file}: Python project ${JSON.stringify(name)} has no tracked pyproject.toml`);
    }
  }
  return errors;
}

/**
 * Repository semantics requested by the environment: OWNERS_REPO when set (CI sets it per repository), else
 * undefined so that verifyOwners falls back to the checkout's default ("next" when the next manifest exists).
 */
export function repoFromEnv(env = process.env) {
  if (!env.OWNERS_REPO) return undefined;
  if (!REPOS.includes(env.OWNERS_REPO)) {
    throw new OwnersError("invalid-repo", `OWNERS_REPO must be "public" or "next", not ${JSON.stringify(env.OWNERS_REPO)}`, { repo: env.OWNERS_REPO });
  }
  return env.OWNERS_REPO;
}

/** Disagreements between a checkout's manifests and its tree; `repo` defaults to the checkout's semantics. */
export function verifyOwners({ root = REPO_ROOT, repo } = {}) {
  const owners = loadOwners({ root });
  repo ??= owners.defaultRepo;
  if (!REPOS.includes(repo)) throw new OwnersError("invalid-repo", `--repo must be "public" or "next", not ${JSON.stringify(repo)}`, { repo });
  const files = trackedFiles(root);
  return [
    ...findOwnershipErrors({
      owners,
      repo,
      files,
      releases: readReleaseEntries(root, repo),
      python: readPythonProjects(root, files),
    }),
    ...findWorkflowGuardErrors(readWorkflows(root, files)),
  ];
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = arg.split(/=(.*)/s, 2);
    if (flag !== "--repo" && flag !== "--root") throw new Error(`unknown argument ${arg}`);
    const value = inline ?? argv[++index];
    if (value === undefined || value === "") throw new Error(`${flag} needs a value`);
    options[flag.slice(2)] = flag === "--root" ? path.resolve(value) : value;
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let errors;
  try {
    const options = parseArgs(process.argv.slice(2));
    options.repo ??= repoFromEnv();
    errors = verifyOwners(options);
  } catch (error) {
    console.error(error instanceof OwnersError ? `error (${error.code}): ${error.message}` : `error: ${error.message}`);
    process.exit(1);
  }
  if (errors.length > 0) {
    console.error(`Ownership manifest and tree disagree (${errors.length}):`);
    for (const message of errors) console.error(`  ${message}`);
    process.exit(1);
  }
  console.log("Ownership manifests match the tree.");
}
