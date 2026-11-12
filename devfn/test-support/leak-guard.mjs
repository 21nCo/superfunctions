// DevFn test leak guard.
//
// A DevFn wrapper detaches into its own session, so stopping the test runner's process
// group never stops it, and a temp directory a test forgets stays in the shared temp
// folder. This guard gives each Vitest run its own temp root and each test file its own
// folder inside that root, and marks the processes the run starts. When a test file's
// hooks have finished, and again when the run ends or is interrupted, it lists every
// process and temp entry the file or run left behind and fails, then stops those
// processes and removes the folders so a failing run leaves nothing behind either.
//
// A process belongs to a file or the run when its command line, working directory or
// environment names a path under that file's folder, the run's root or a directory a test
// registered with guardDirectory, when it inherited the file's or run's marker variable, or
// when it descends from the file's worker or the run's own process. All of these are unique
// to the run, so the guard never signals a process it cannot attribute to this run.
//
// The run's check also looks for processes it cannot attribute: ones started during the run
// that run from, or name, a path in the worktree, and were orphaned (re-parented to init) as
// a detached wrapper is once whatever started it exits. They fail the run and are listed, but
// are never signalled.
//
// Node built-ins only: DevFn packages also install and test on their own, without the
// workspace's node_modules.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RUN_MARKER = "SFN_TEST_LEAK_GUARD_RUN";
export const FILE_MARKER = "SFN_TEST_LEAK_GUARD_FILE";
export const ROOT_VARIABLE = "SFN_TEST_LEAK_GUARD_ROOT";
/** The temp folder the outermost guarded run started with, where machine-wide test locks live (shared-locks.mjs). */
export const ORIGINAL_TEMP_VARIABLE = "SFN_TEST_LEAK_GUARD_ORIGINAL_TMPDIR";
const MAIN_PID_VARIABLE = "SFN_TEST_LEAK_GUARD_MAIN_PID";
const TEMP_VARIABLES = ["TMPDIR", "TMP", "TEMP"];
// Kept short: a Unix socket path, such as tsx's IPC pipe in TMPDIR, has room for about 103
// bytes on macOS, whose temp folder already takes about 50.
const ROOT_PREFIX = "devfn-tests-";
const FILE_PREFIX = "f-";
// Files the guard keeps in the run's root: the run's own record, which a sibling run reads to
// leave this run's processes alone, the directories its tests registered with guardDirectory,
// the machine-wide locks its tests named (shared-locks.mjs) and the test files' own folders.
const RUN_RECORD = ".leak-guard-run.json";
const DIRECTORY_RECORD = ".leak-guard-directories";
const LOCK_RECORD = ".leak-guard-locks";
const FOLDER_RECORD = ".leak-guard-folders";
const isGuardRecord = (name) => [RUN_RECORD, DIRECTORY_RECORD, LOCK_RECORD, FOLDER_RECORD].includes(name);
// Entries a tool creates in TMPDIR for its own reuse rather than for a test: Node's compile
// cache and tsx's per-user cache, which the tsx loader that runs TypeScript fixtures names
// exactly so. Any other entry, such as a test's own mkdtemp("tsx-") folder, is a leftover.
const TOOL_CACHES = ["node-compile-cache", `tsx-${process.geteuid?.() ?? os.userInfo().username}`];
const isToolCache = (name) => TOOL_CACHES.includes(name);
// Processes an orphan is re-parented to: launchd or init, or a Linux subreaper such as `systemd --user`.
const isReaper = (entry) => entry.pid <= 1 || /^(?:\S*\/)?(?:launchd|init|systemd|tini|dumb-init|docker-init)(?:\s|$)/.test(entry.command);

/**
 * Links the tool caches of the original temp folder into a new temp folder, so tools started
 * with TMPDIR pointing there keep reusing them. Removing the folder removes only the links.
 */
function linkToolCaches(directory, original) {
  if (!original) return;
  for (const name of TOOL_CACHES) {
    try {
      const target = path.join(original, name);
      mkdirSync(target, { recursive: true });
      symlinkSync(target, path.join(directory, name), "dir");
    } catch { /* the tool then fills a cache of its own in the folder */ }
  }
}
const FILE_GRACE_MS = 3_000;
const RUN_GRACE_MS = 5_000;
const STOP_GRACE_MS = 2_000;
// How long the guard keeps stopping processes that appear while it stops a scope's processes.
const STOP_DEADLINE_MS = 10_000;
// How many times the exit cleanup lists and kills the run's processes.
const EXIT_ROUNDS = 3;
const MAX_LISTED = 40;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The guard runs the system ps and lsof even while a test points PATH at stubs, and gives them
// no marker and no temp variables, so they never match themselves.
const TOOL_PATH = ["/bin", "/usr/bin", "/usr/sbin", "/sbin", process.env.PATH].filter(Boolean).join(path.delimiter);
const toolEnv = () => ({ PATH: TOOL_PATH, LC_ALL: "C" });

function run(command, args, timeout = 15_000, env = toolEnv()) {
  // A signal sent to this process's group, as turbo cancels a task, also reaches a tool the guard
  // is running then. A listing cut short that way would read as nothing left, so the tool runs
  // again. A tool that times out reports an error instead and is not run again.
  for (let attempt = 1; ; attempt += 1) {
    const result = spawnSync(command, args, { encoding: "utf8", env, timeout, maxBuffer: 64 * 1024 * 1024 });
    if (result.error) return undefined;
    if (!result.signal || attempt === 3) return result;
  }
}

/** The spellings of a directory a process can show: as given, resolved, and with or without macOS's /private prefix. */
export function pathAliases(directory) {
  const spellings = new Set([directory]);
  try { spellings.add(realpathSync(directory)); } catch { /* already removed */ }
  for (const spelling of [...spellings]) {
    if (spelling.startsWith("/private/")) spellings.add(spelling.slice("/private".length));
    else if (/^\/(?:tmp|var)(?:\/|$)/.test(spelling)) spellings.add(`/private${spelling}`);
  }
  return [...spellings];
}

/** Elapsed time from `ps -o etime` ([[dd-]hh:]mm:ss) in seconds. */
function elapsedSeconds(value) {
  const [days, clock] = value.includes("-") ? value.split("-") : ["0", value];
  return clock.split(":").map(Number).reduce((total, part) => total * 60 + part, 0) + Number(days) * 86_400;
}

let clockTicks;
function linuxClockTicks() {
  clockTicks ??= Number(run("getconf", ["CLK_TCK"])?.stdout.trim()) || 100;
  return clockTicks;
}

function listLinux() {
  let names;
  try { names = readdirSync("/proc"); } catch { return undefined; }
  let uptime;
  try { uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]); } catch { uptime = undefined; }
  const processes = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let stat;
    try { stat = readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { continue; }
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z" || fields[0] === "X") continue;
    // Arguments and variables stay NUL-separated, so a value with a space in it stays one value.
    const read = (file) => { try { return readFileSync(`/proc/${pid}/${file}`, "utf8"); } catch { return ""; } };
    const argv = read("cmdline");
    let cwd;
    try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch { /* another user's process */ }
    // Field 22 of stat, the start time in clock ticks since boot.
    const elapsed = uptime === undefined ? undefined : Math.max(0, Math.floor(uptime - Number(fields[19]) / linuxClockTicks()));
    // `command` is the arguments joined with spaces, for reports and matching a program name.
    // `started`, field 22 itself, tells this process from a later one given its ID (stillRunning).
    processes.push({ pid, ppid: Number(fields[1]), pgid: Number(fields[2]), elapsed, started: Number(fields[19]), command: argv.replaceAll("\0", " ").trim(), argv, environment: read("environ"), separated: true, cwd });
  }
  return processes;
}

// ps -o lstart, the second a process started, in UTC and the C locale ("Thu Nov 12 02:42:52 2026"). It
// is read from the process, not counted back from the time of the listing, so every reading of
// one process's start is the same.
const UTC_TOOL_ENV = () => ({ ...toolEnv(), TZ: "UTC0" });
const LSTART = String.raw`(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)`;
const darwinStart = (lstart) => `darwin-utc:${lstart.replaceAll(/\s+/g, " ")}`;

function listDarwin(sinceMs) {
  const columns = ["-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "etime=", "-o", "stat=", "-o", "lstart=", "-o", "command="];
  const plain = run("ps", ["-A", "-ww", ...columns], 15_000, UTC_TOOL_ENV());
  // -E appends each process's initial environment to its command; it is read only to find the marker.
  const withEnvironment = run("ps", ["-A", "-ww", "-E", ...columns], 15_000, UTC_TOOL_ENV());
  if (!plain || plain.status !== 0 || !withEnvironment) return undefined;
  const parse = (output) => new Map(output.split("\n").flatMap((line) => {
    const match = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\S+)\\s+(\\S+)\\s+${LSTART}\\s(.*)$`).exec(line);
    return match ? [[Number(match[1]), { ppid: Number(match[2]), pgid: Number(match[3]), elapsed: elapsedSeconds(match[4]), state: match[5], started: darwinStart(match[6]), text: match[7] }]] : [];
  }));
  const commands = parse(plain.stdout);
  const environments = parse(withEnvironment.stdout);
  const processes = [];
  for (const [pid, entry] of commands) {
    // The listing shows the ps that made it, a child of this process.
    if (entry.state.startsWith("Z") || pid === plain.pid || pid === withEnvironment.pid) continue;
    const full = environments.get(pid)?.text ?? "";
    // `started`, its absolute start, tells this process from a later one given its ID (stillRunning).
    processes.push({ pid, ppid: entry.ppid, pgid: entry.pgid, elapsed: entry.elapsed, started: entry.started, command: entry.text.trim(), environment: full.startsWith(entry.text) ? full.slice(entry.text.length) : "", cwd: undefined });
  }
  // Working directories come from lsof, for processes started since the run began only.
  const window = Math.ceil((Date.now() - sinceMs) / 1000) + 5;
  const recent = processes.filter((entry) => entry.elapsed <= window && entry.pid !== process.pid);
  if (recent.length > 0) {
    const lsof = run("lsof", ["-nP", "-a", "-d", "cwd", "-Fpn", "-p", recent.map((entry) => entry.pid).join(",")]);
    const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
    let current;
    for (const line of lsof?.stdout.split("\n") ?? []) {
      if (line.startsWith("p")) current = byPid.get(Number(line.slice(1)));
      else if (line.startsWith("n") && current) current.cwd = line.slice(1);
    }
  }
  return processes;
}

/** Every process visible to this user, or undefined where the platform has no supported listing. */
export function listProcesses(sinceMs = 0) {
  if (process.platform === "linux") return listLinux();
  if (process.platform === "darwin") return listDarwin(sinceMs);
  return undefined;
}

function ancestorsOf(pid, processes) {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const ancestors = new Set();
  for (let current = byPid.get(pid); current && current.ppid > 0 && !ancestors.has(current.ppid); current = byPid.get(current.ppid)) ancestors.add(current.ppid);
  return ancestors;
}

function descendantsOf(pid, processes) {
  const children = new Map();
  for (const entry of processes) children.set(entry.ppid, [...(children.get(entry.ppid) ?? []), entry.pid]);
  const descendants = new Set();
  for (const pending = [...(children.get(pid) ?? [])]; pending.length > 0;) {
    const next = pending.pop();
    if (descendants.has(next)) continue;
    descendants.add(next);
    pending.push(...(children.get(next) ?? []));
  }
  return descendants;
}

// How the guard reads a path out of a command line or environment. Linux's /proc keeps each
// argument and variable whole, NUL-separated, so a path is a whole argument, after a `KEY=` or
// `--option=` prefix and `file://`, or a whole variable's value, which only a variable known to
// hold a `:`-separated list (LIST_VARIABLES) splits.
//
// macOS's ps listing joins arguments and variables with spaces, so there a value starts after
// whitespace, a quote, an assignment prefix, `file://` or a `:` list separator, and runs to the
// next of those. Such a listing cannot show where a value with a space, quote or `:` in it starts
// or ends: `node /x <root>/y` may be one argument `/x <root>/y`, and `<root> copy/y` another
// path, whether or not those paths exist. So every match there is ambiguous: it fails a run, but
// owns a process only with independent evidence (see attributeProcesses). Nothing else ends a path: `;`, `(`, `[`, `-`, `.` and non-ASCII letters may all be part of a
// file name, so `/x/repo;other` and `/x/repo-dev-42` are not under `/x/repo`.
const SEPARATOR = /[\s"'`]/;
const LIST_SEPARATOR = ":";
const ASSIGNMENT = /^[^/=:]*=/;
const LIST_VARIABLES = new Set(["PATH", "NODE_PATH", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH", "LIBRARY_PATH", "MANPATH", "PYTHONPATH", "CLASSPATH", "PKG_CONFIG_PATH", "GOPATH"]);
// What may come between the start of a value and a path in it.
const isValuePrefix = (text) => text.endsWith(LIST_SEPARATOR) || /^(?:[^/=:]*=)?(?:file:\/\/)?$/i.test(text);

/** The value without trailing slashes, keeping a lone `/`. Linear, unlike a trailing-slash regex. */
function trimTrailingSlashes(value) {
  let end = value.length;
  while (end > 1 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

// Path containment. Every test of whether a value a process shows names a path under a root is
// in this section, up to "End of path containment": classifyValue decides it, and everything
// else uses its result. A self-test checks that no such test is made anywhere else.
const isPathUnder = (value, root) => value === root || value.startsWith(`${root}/`);
/**
 * An absolute value with its `.` and `..` segments and repeated slashes resolved as the system
 * resolves them, so `<root>/../other` is not under `<root>`: `..` goes up from where the path so
 * far really is, through a symbolic link where one is. Undefined when the system could not
 * follow it: the path before a `..` is missing or not a directory, as in `/dev/null/../x`.
 * Every named path goes through this.
 */
function normalPath(value) {
  if (!value.startsWith("/")) return value;
  let current = "/";
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      try {
        current = realpathSync.native(current);
        if (!statSync(current).isDirectory()) return undefined;
      } catch { return undefined; }
      current = path.posix.dirname(current);
    } else current = path.posix.join(current, segment);
  }
  return current;
}

const DOT_DOT = /(?:^|\/)\.\.(?:\/|$)/;

/** `value` spelled from `root` when it is at or under one of root's spellings, else undefined. */
function respelled(value, root) {
  if (value === undefined || isPathUnder(value, root)) return value;
  const alias = pathAliases(root).find((spelling) => isPathUnder(value, spelling));
  return alias === undefined ? undefined : `${root}${value.slice(alias.length)}`;
}

const NONE = Object.freeze({ kind: "none" });
const FILE_URL = /^file:/i;

/**
 * How one value a process shows names a path at or under `root`: a whole /proc argument or
 * variable value, a working directory, or a value read out of a macOS listing. Returns
 * `{ kind, path }`, `path` spelled from `root`:
 *
 * - "exact" when every reading of the value is a path under `root`, so it may justify a signal;
 * - "ambiguous" when only some readings are, or when the value cannot be read for certain: it is
 *   reported and fails the run, but is never signalled on its own;
 * - "none" when no reading is.
 *
 * A `file:` URL is read as a URL first, percent-decoding included, so `file://<root>/%2e%2e/x` is
 * `<root>/../x`, which is not under `<root>`; one Node cannot decode is ambiguous when its text
 * names a path under `root`. A `..` is then read two ways: as the system resolves it, through
 * symbolic links (normalPath), and lexically, as Node resolves its script. Both readings of
 * `<root>/link/../x` may lie under `<root>` even where they differ, and then it is exact.
 */
export function classifyValue(raw, root) {
  let value = raw;
  if (FILE_URL.test(value)) {
    try { value = fileURLToPath(value); } catch { return undecodableUrl(value, root); }
  }
  if (!value.startsWith("/")) return NONE;
  if (!DOT_DOT.test(value)) {
    const normal = normalPath(value);
    return isPathUnder(normal, root) ? { kind: "exact", path: normal } : NONE;
  }
  const physical = respelled(normalPath(value), root);
  const lexical = respelled(trimTrailingSlashes(path.posix.normalize(value)), root);
  if (physical === undefined && lexical === undefined) return NONE;
  return { kind: physical !== undefined && lexical !== undefined ? "exact" : "ambiguous", path: physical ?? lexical };
}

/** A `file:` URL that fileURLToPath rejects, such as one with an encoded `/`: ambiguous when its decoded text names a path under `root`. */
function undecodableUrl(value, root) {
  let text = value.replace(/^file:(?:\/\/)?/i, "");
  try { text = decodeURIComponent(text); } catch { /* read as written */ }
  if (!text.startsWith("/")) return NONE;
  const lexical = respelled(trimTrailingSlashes(path.posix.normalize(text)), root);
  return lexical === undefined ? NONE : { kind: "ambiguous", path: lexical };
}

/** Whether a whole path, such as a Compose project's working directory, is at or under one of `roots`. */
const isUnder = (candidate, roots) => roots.some((root) => classifyValue(candidate, root).kind === "exact");

/** The values of a NUL-separated /proc listing that may be paths. */
function separatedValues(text, environment) {
  return text.split("\0").flatMap((field) => {
    if (!environment) return [field.replace(ASSIGNMENT, "")];
    const at = field.indexOf("=");
    if (at <= 0) return [];
    const value = field.slice(at + 1);
    return LIST_VARIABLES.has(field.slice(0, at)) ? value.split(LIST_SEPARATOR) : [value];
  });
}

/**
 * The paths at or under `root` that `text` names, each `ambiguous` when it comes from a
 * space-joined listing, which cannot show where a value starts or ends.
 *
 * In such a listing, a value that stops at a separator may go on past it: `node <root>/.. sibling/x`
 * may name `<root>/..` or `<root>/.. sibling/x`, and `node <root> copy/x` `<root>` or `<root> copy/x`.
 * So the value is read up to the separator and up to each later separator before the next `/`
 * (continuations), and it names a path under `root` when any of those readings does. It is `cut`
 * when another of them does not: then `besides` holds the readings outside `root`, any of which
 * may be what the process names, and `within` those under `root` other than `root` itself.
 */
function namedPaths(text, root, { separated = false, environment = false } = {}) {
  if (separated) {
    return separatedValues(text, environment).flatMap((raw) => {
      const { kind, path: named } = classifyValue(raw, root);
      return kind === "none" ? [] : [{ path: named, ambiguous: kind === "ambiguous" }];
    });
  }
  const paths = [];
  for (let at = text.indexOf(root); at !== -1; at = text.indexOf(root, at + 1)) {
    let start = at;
    while (start > 0 && !SEPARATOR.test(text[start - 1])) start -= 1;
    const prefix = text.slice(start, at);
    if (!isValuePrefix(prefix)) continue;
    // From the end of `root`, so a root with a space in it still matches.
    let end = at + root.length;
    while (end < text.length && !SEPARATOR.test(text[end]) && text[end] !== LIST_SEPARATOR) end += 1;
    // A value after a `file:` or `file://` scheme, in any case, is read as that URL. Its whitespace
    // is encoded, so that a reading cut short after a space keeps that space, as the URL it may be
    // part of does (`file://<root>/%2e%2e /x` is `<root>/.. /x`), instead of losing it to URL parsing.
    const url = /file:(?:\/\/)?$/i.exec(prefix)?.[0] ?? "";
    const readable = (reading) => (url ? `${url}${reading.replaceAll(/\s/g, encodeURIComponent)}` : reading);
    const readings = [text.slice(at, end), ...(end < text.length ? continuations(text, at, end) : [])]
      .map((reading) => ({ reading, ...classifyValue(readable(reading), root) }));
    const under = readings.filter(({ kind }) => kind !== "none");
    if (under.length === 0) continue;
    const besides = readings.filter(({ kind }) => kind === "none").map(({ reading }) => reading);
    const within = under.map(({ path: named }) => named).filter((named) => named !== root);
    paths.push({ path: under[0].path, ambiguous: true, cut: besides.length > 0, besides, within });
  }
  return paths;
}

const MAX_CONTINUATIONS = 32;

/** The texts from `at` to each separator after `end`, then to the next `/` or the end of `text`. */
function continuations(text, at, end) {
  const slash = text.indexOf("/", end);
  const stop = slash === -1 ? text.length : slash;
  const ends = [];
  for (let index = end + 1; index < stop && ends.length < MAX_CONTINUATIONS; index += 1) if (SEPARATOR.test(text[index]) || text[index] === LIST_SEPARATOR) ends.push(index);
  return [...ends, stop].map((index) => text.slice(at, index));
}
// End of path containment.

/**
 * The paths at or under `root` that `text` names. With `separated`, the text is NUL-separated,
 * as Linux's /proc keeps it, and `environment` says it holds variables rather than arguments.
 */
export function pathsNamedUnder(text, root, options) {
  return namedPaths(text, root, options).map(({ path: named }) => named);
}

/**
 * How a process names a path under the given roots in its command, environment or working
 * directory: "exact", "ambiguous" when it names one only in a value classifyValue cannot read for
 * certain or in a space-joined listing, "cut" when each such value may also be read as a path
 * outside the roots, or undefined. `accept(path, root, named)` can reject a named path, such as
 * one inside a nested checkout.
 */
function namesPathUnder(entry, roots, accept = () => true) {
  let found;
  for (const root of roots) {
    const cwd = entry.cwd === undefined ? NONE : classifyValue(entry.cwd, root);
    if (cwd.kind === "exact" && accept(cwd.path, root)) return "exact";
    if (cwd.kind === "ambiguous" && accept(cwd.path, root)) found = "ambiguous";
    const named = [
      ...namedPaths(entry.argv ?? entry.command, root, { separated: entry.separated }),
      ...namedPaths(entry.environment, root, { separated: entry.separated, environment: true }),
    ].filter((named) => accept(named.path, root, named));
    if (named.some(({ ambiguous }) => !ambiguous)) return "exact";
    if (named.some(({ cut }) => !cut)) found = "ambiguous";
    else if (named.length > 0) found ??= "cut";
  }
  return found;
}

/**
 * Whether `candidate`, a path under `root`, lies in another checkout nested in it, such as a
 * worktree under the main checkout's `.worktrees`: a directory between them holds a `.git` entry.
 */
export function inNestedCheckout(candidate, root, cache = new Map()) {
  const nested = [];
  let answer = false;
  // `candidate` is a path classifyValue spelled from `root`, so going up from it reaches `root`.
  for (let directory = candidate; directory !== root && directory !== path.dirname(directory); directory = path.dirname(directory)) {
    if (cache.has(directory)) { answer = cache.get(directory); break; }
    nested.push(directory);
    if (existsSync(path.join(directory, ".git"))) { answer = true; break; }
  }
  for (const directory of nested) cache.set(directory, answer);
  return answer;
}

/**
 * The processes a scope owns, which it may signal: those carrying its marker, descending from its
 * `parent` process, or running from a path under its roots or naming one in their command or
 * environment (DevFn passes TMPDIR on to what it starts). `ambiguous` holds those whose only link
 * is an ambiguous path (see namesPathUnder), unless `vouch(entry)` gives independent evidence:
 * they are reported, never signalled. The guard's own process and its ancestors are never
 * included, nor are `excluded` processes, though their descendants may be.
 */
export function attributeProcesses(processes, { marker, roots, parent, excluded = () => false, vouch = () => false }) {
  const ancestors = ancestorsOf(process.pid, processes);
  const descendants = parent === undefined ? new Set() : descendantsOf(parent, processes);
  const owned = [];
  const ambiguous = [];
  for (const entry of processes) {
    if (entry.pid === process.pid || ancestors.has(entry.pid) || excluded(entry)) continue;
    const named = (marker !== undefined && entry.environment.includes(marker)) || descendants.has(entry.pid) ? "exact" : namesPathUnder(entry, roots);
    if (named === "exact" || (named !== undefined && vouch(entry))) owned.push(entry);
    else if (named !== undefined) ambiguous.push(entry);
  }
  return { owned, ambiguous };
}

/** The processes a scope owns and may signal (see attributeProcesses). */
export function ownedProcesses(processes, scope) {
  return attributeProcesses(processes, scope).owned;
}

/**
 * Stops every process that runs from, or names, a path under the given directories, with the
 * detached process group it leads, and any such process that appears while they stop. One that
 * names them only in a macOS listing is stopped when it also carries this file's or run's marker
 * or descends from this process. `sinceMs` bounds the working-directory lookup to processes
 * started since then. Returns the processes still running afterwards.
 */
export async function stopProcessesUnder(directories, sinceMs = 0) {
  const roots = directories.flatMap(pathAliases);
  const markers = [FILE_MARKER, RUN_MARKER].filter((name) => process.env[name]).map((name) => `${name}=${process.env[name]}`);
  const find = () => {
    const listed = listProcesses(sinceMs);
    if (!listed) return listed;
    const descendants = descendantsOf(process.pid, listed);
    return ownedProcesses(listed, { roots, vouch: (entry) => descendants.has(entry.pid) || markers.some((marker) => entry.environment.includes(marker)) });
  };
  const owned = find();
  return owned && owned.length > 0 ? await stopProcesses(owned, find) : [];
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; } };

let ownGroup;
/** This process's group, which the guard never signals: the runner and its siblings are in it. */
function ownProcessGroup() {
  ownGroup ??= Number(run("ps", ["-o", "pgid=", "-p", String(process.pid)])?.stdout.trim()) || undefined;
  return ownGroup;
}

/**
 * Signals each process the guard can tell, just before it signals it, is still the process its
 * listing found: the same process ID with the same start (identityOf, read for all of them at
 * once), running and not a zombie. A process that leads its own group (a detached wrapper) is
 * signalled with its whole group, which holds only what it started. Before SIGTERM, after which a
 * leader may exit and leave its group behind, the guard records which processes are in that group
 * (witnessGroup) and signals it only if the leader is still itself after that. Once a leader has
 * exited, its group is signalled only while it holds a process the guard can link to the leader
 * (inLeadersGroup) that a read of its own, just before the signal, shows is still that process
 * and still in the group. The group's processes are otherwise added to `held`, to be reported,
 * never signalled. A process ID that now names a process started at another time is never
 * signalled, nor is its group, and nor is a process whose start cannot be read. Returns those it
 * signalled.
 */
function signalAll(processes, signal, held = new Map()) {
  const group = ownProcessGroup();
  const signalled = [];
  const send = (entry, target) => { signalled.push(entry); try { process.kill(target, signal); } catch { /* ESRCH: already gone */ } };
  const states = processStates(processes.map((entry) => entry.pid));
  for (const entry of processes) {
    const leads = entry.pgid === entry.pid && entry.pgid !== group;
    const current = identityOf(entry, states);
    if (current?.same) {
      const wholeGroup = leads && current.pgid === entry.pid;
      // A leader that has just exited is left to the next round, which treats it as exited.
      if (wholeGroup && signal === "SIGTERM" && !witnessGroup(entry)) continue;
      send(entry, wholeGroup ? -entry.pid : entry.pid);
    } else if (leads && current?.exited) {
      const members = groupMembers(entry.pid) ?? [];
      if (members.some((member) => inLeadersGroup(entry, member) && identityOf(member)?.pgid === entry.pid)) send(entry, -entry.pid);
      else for (const member of members) held.set(member.pid, member);
    }
  }
  return signalled;
}

// Per group leader (`${pid}:${started}`): the processes it was seen leading (`${pid}:${started}`),
// and when a read last showed the leader was itself, in seconds on the clock starts are read in.
const groupWitnesses = new Map();
const leaderSeen = new Map();
// A group ID in use is never given to a new process, so a group whose leader has exited is
// another only if all of it exited and its ID went to a new leader that started a process in it.
// Within this many seconds of a read that showed the leader running, that would take the system's
// whole range of process IDs: the bound the exact start comparison relies on as well (identityOf).
const REUSE_BOUND_SECONDS = 2;

/**
 * Whether `member` of the group `leader` led is linked to that leader: seen in the group while the
 * leader was itself (witnessGroup), or started within REUSE_BOUND_SECONDS after a read last showed
 * the leader running, as what a wrapper starts as it exits does.
 */
function inLeadersGroup(leader, member) {
  const key = `${leader.pid}:${leader.started}`;
  if (groupWitnesses.get(key)?.has(`${member.pid}:${member.started}`)) return true;
  const seen = leaderSeen.get(key);
  return seen !== undefined && startSeconds(member.started) <= seen + REUSE_BOUND_SECONDS;
}

/** A start as listings record it, in seconds: since boot on Linux, since the epoch on macOS (a whole second). */
function startSeconds(started) {
  if (typeof started === "number") return started / linuxClockTicks();
  const [, month, day, clock, year] = String(started).replace(/^darwin-utc:/, "").split(" ");
  const [hours, minutes, seconds] = String(clock).split(":").map(Number);
  const index = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(month);
  return index < 0 ? Number.NaN : Date.UTC(Number(year), index, Number(day), hours, minutes, seconds) / 1000;
}

/** Now, on the clock startSeconds reads, or undefined when it cannot be read. */
function clockSeconds() {
  if (process.platform !== "linux") return Date.now() / 1000;
  try { return Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]); } catch { return undefined; }
}

/**
 * Records which processes are in the group `entry` leads, and whether `entry` is, after reading
 * them, still itself: only then was the group read the one it leads.
 */
function witnessGroup(entry) {
  const members = groupMembers(entry.pid);
  if (!identityOf(entry)?.same) return false;
  const key = `${entry.pid}:${entry.started}`;
  const seen = groupWitnesses.get(key) ?? new Set();
  for (const member of members ?? []) if (member.pid !== entry.pid) seen.add(`${member.pid}:${member.started}`);
  groupWitnesses.set(key, seen);
  return true;
}

/** The running processes in group `pgid`, as listings record them, or undefined when they cannot be listed. */
function groupMembers(pgid) {
  if (process.platform === "linux") {
    let names;
    try { names = readdirSync("/proc"); } catch { return undefined; }
    return names.filter((name) => /^\d+$/.test(name)).flatMap((name) => {
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (Number(fields[2]) !== pgid || /^[ZX]/.test(fields[0])) return [];
        const command = readFileSync(`/proc/${name}/cmdline`, "utf8").replaceAll("\0", " ").trim();
        return [{ pid: Number(name), ppid: Number(fields[1]), pgid, started: Number(fields[19]), command, environment: "" }];
      } catch { return []; }
    });
  }
  if (process.platform !== "darwin") return undefined;
  const listing = run("ps", ["-A", "-ww", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "stat=", "-o", "lstart=", "-o", "command="], 15_000, UTC_TOOL_ENV());
  if (!listing || listing.status !== 0) return undefined;
  return listing.stdout.split("\n").flatMap((line) => {
    const match = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\S+)\\s+${LSTART}\\s(.*)$`).exec(line);
    if (!match || Number(match[3]) !== pgid || match[4].startsWith("Z") || Number(match[1]) === listing.pid) return [];
    return [{ pid: Number(match[1]), ppid: Number(match[2]), pgid, started: darwinStart(match[5]), command: match[6].trim(), environment: "" }];
  });
}

/** Whether `entry` may still run: not when its ID names no process, a zombie or a process started at another time. */
const mayRun = (entry, states) => alive(entry.pid) && stillRunning(entry, states) !== false;

async function waitForExit(processes, graceMs) {
  const running = () => {
    const states = processStates(processes.filter((entry) => alive(entry.pid)).map((entry) => entry.pid));
    return processes.some((entry) => mayRun(entry, states));
  };
  for (const deadline = Date.now() + graceMs; Date.now() < deadline && running();) await pause(100);
}

const sameProcesses = (a, b) => {
  const keys = new Set(a.map((entry) => `${entry.pid}:${entry.started}`));
  return keys.size === b.length && b.every((entry) => keys.has(`${entry.pid}:${entry.started}`));
};

// Rounds in a row that signal nothing while the scope still lists the same processes before the
// guard gives up on telling they are still the ones it found: a read of a start that fails once,
// under load, say, is read again.
const IDENTITY_TRIES = 3;

/**
 * Stops the given processes: SIGTERM to each (its group when it leads one), then SIGKILL to each
 * and to every group one of them led, each only once signalAll can tell it is still the process
 * listed. A process may start another as it stops, such as a wrapper's SIGTERM handler, so with
 * `find`, which lists the scope's processes again, it keeps killing whatever the scope still holds
 * until nothing is left, STOP_DEADLINE_MS has passed, or IDENTITY_TRIES rounds in a row have
 * signalled nothing and the listing still shows the same processes (`refused`). `remaining` holds
 * the processes still running: what `find` still lists (`listed`), or else those of the given ones
 * that may still run, and the processes of an exited leader's group signalAll held back.
 */
async function stopRounds(processes, find) {
  const deadline = Date.now() + STOP_DEADLINE_MS;
  const held = new Map();
  // Only a process signalled is waited for: one the guard did not signal has no reason to exit now.
  await waitForExit(signalAll(processes, "SIGTERM", held), STOP_GRACE_MS);
  for (let pending = processes, idle = 0; ;) {
    // Stragglers found by listing again started while the scope was stopping, so they get no grace.
    const signalled = signalAll(pending, "SIGKILL", held);
    await waitForExit(signalled, STOP_GRACE_MS);
    const listed = (find && find()) ?? pending.filter((entry) => mayRun(entry));
    idle = signalled.length === 0 && sameProcesses(listed, pending) ? idle + 1 : 0;
    if (!find || listed.length === 0 || Date.now() >= deadline || idle >= IDENTITY_TRIES) {
      const pids = new Set(listed.map((entry) => entry.pid));
      return { listed, refused: idle >= IDENTITY_TRIES, remaining: [...listed, ...[...held.values()].filter((entry) => !pids.has(entry.pid) && mayRun(entry))] };
    }
    if (idle > 0) await pause(250);
    pending = listed;
  }
}

/** Stops the given processes (stopRounds) and returns those still running. */
export async function stopProcesses(processes, find) {
  return (await stopRounds(processes, find)).remaining;
}

/** The note for processes stopProcesses left running. */
const unstoppedNote = (unstopped) => `Not stopped: ${unstopped.map((entry) => entry.pid).join(", ")}. Each still ran after SIGKILL, or the guard could not tell it was still the process it had listed, or that it was still in the group of a stopped process that has exited, so it did not signal it.`;

/**
 * What a process ID names now, read for that ID alone (or taken from `states`, read for several
 * at once), so that it can be told while a full listing fails and just before a signal:
 * { exited } when nothing runs as `entry` (the ID names no process, or a zombie that started when
 * `entry` did), { same, pgid } when it is still `entry`, running, and { other } when the ID now
 * names a process started at another time. Undefined when that cannot be read, or `entry` has no
 * recorded start. A read that shows a group leader is itself is recorded (inLeadersGroup).
 */
function identityOf(entry, states = processStates([entry.pid])) {
  if (entry.started === undefined) return undefined;
  const state = states.get(entry.pid);
  if (state === undefined) return undefined;
  if (state === null) return { exited: true };
  // The same absolute start, with no tolerance: a start even a second apart means the ID now names
  // a later process, and the one the listing found has exited. Reusing an ID within the second it
  // was freed would take macOS's whole range of IDs in that second.
  if (state.started !== entry.started) return { other: true };
  if (state.zombie) return { exited: true };
  const now = entry.pgid === entry.pid ? clockSeconds() : undefined;
  if (now !== undefined) leaderSeen.set(`${entry.pid}:${entry.started}`, now);
  return { same: true, pgid: state.pgid };
}

/**
 * Each process's start (as the listings record it), group and whether it is a zombie, by ID: null
 * when no process has the ID, undefined when that cannot be read. macOS reads them all with one ps.
 */
function processStates(pids) {
  const states = new Map();
  if (process.platform === "linux") {
    for (const pid of pids) {
      let stat;
      try { stat = readFileSync(`/proc/${pid}/stat`, "utf8"); } catch (error) { states.set(pid, error?.code === "ENOENT" ? null : undefined); continue; }
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      states.set(pid, { started: Number(fields[19]), pgid: Number(fields[2]), zombie: /^[ZX]/.test(fields[0]) });
    }
    return states;
  }
  const unique = [...new Set(pids)];
  const result = process.platform === "darwin" && unique.length > 0
    ? run("ps", ["-o", "pid=", "-o", "lstart=", "-o", "stat=", "-o", "pgid=", "-p", unique.join(",")], 15_000, UTC_TOOL_ENV())
    : undefined;
  // ps lists the processes that run, says nothing of the others, and exits 1 when none of them runs.
  const complete = result && !result.signal && [0, 1].includes(result.status) && !result.stderr.trim();
  const read = new Map();
  for (const line of complete ? result.stdout.split("\n") : []) {
    const pid = /^\s*(\d+)\s/.exec(line)?.[1];
    const match = new RegExp(`^\\s*\\d+\\s+${LSTART}\\s+(\\S+)\\s+(\\d+)`).exec(line);
    if (pid) read.set(Number(pid), match ? { started: darwinStart(match[1]), pgid: Number(match[3]), zombie: match[2].startsWith("Z") } : undefined);
  }
  for (const pid of unique) states.set(pid, !complete ? undefined : read.has(pid) ? read.get(pid) : null);
  return states;
}

/**
 * Whether `entry`, from an earlier listing, is still that same process and running (identityOf):
 * false once it has exited or is a zombie, or when its ID now belongs to a process started at
 * another time; undefined when that cannot be read.
 */
function stillRunning(entry, states) {
  const current = identityOf(entry, states);
  return current === undefined ? undefined : current.same === true;
}

/**
 * An earlier classification checked again process by process (stillRunning). Those that have
 * exited go from both results. `remaining` keeps every other one as the listing classified it;
 * `current` moves an owned one that cannot be told, this time, to be the same process to those
 * the guard only reports (ambiguous), since the guard signals only a process it can tell is its
 * own. Each check starts from `remaining`, so one read that fails does not stop the guard from
 * stopping that process once a later read tells it is the same.
 */
function recheck(classified) {
  const remaining = {};
  const current = {};
  const unverified = [];
  for (const [kind, processes] of Object.entries(classified)) {
    remaining[kind] = [];
    current[kind] = [];
    for (const entry of processes) {
      const running = stillRunning(entry);
      if (running === false) continue;
      remaining[kind].push(entry);
      if (kind === "owned" && running !== true) unverified.push(entry);
      else current[kind].push(entry);
    }
  }
  current.ambiguous = [...(current.ambiguous ?? []), ...unverified];
  return { remaining, current };
}

/**
 * Wraps `classify`, which lists a scope's processes by kind ({ owned, ambiguous, ... }), or returns
 * undefined when they cannot be listed. Once a listing has succeeded (or `seed` gives an earlier
 * one), a failed one never reads as the processes having exited: the wrapper returns the last good
 * result instead, checked again process by process (recheck), and sets `stale` until a listing
 * succeeds again. A scope whose last result is stale fails, since a process may have appeared that
 * the guard could not see.
 */
function keepingLast(classify, seed = () => undefined) {
  let last;
  const find = () => {
    const listed = classify();
    if (listed !== undefined) {
      find.stale = false;
      last = listed;
      return last;
    }
    last ??= seed();
    find.stale = last !== undefined;
    if (!find.stale) return undefined;
    const { remaining, current } = recheck(last);
    last = remaining;
    return current;
  };
  find.stale = false;
  return find;
}

const STALE_NOTE = "Listing processes failed after an earlier listing had succeeded, so the guard could not tell which processes remain: it lists those the last listing found that still run, stops only those it can tell are still the same processes, and fails.";

/**
 * Waits up to `graceMs` for the processes `find` lists, by kind ({ owned, ambiguous, ... }), to
 * exit by themselves, those the guard only reports as well as those it would stop, and returns
 * what the last listing still holds, or undefined when the processes cannot be listed.
 */
async function settle(find, graceMs, found = find()) {
  const pending = () => found && Object.values(found).some((processes) => processes.length > 0);
  for (const deadline = Date.now() + graceMs; pending() && Date.now() < deadline; found = find()) await pause(200);
  return found;
}

/**
 * Stops the owned processes in `settled`, what `classify` lists by kind, and takes what the guard
 * only reports from one listing once stopping is done, after a short while for a process the
 * stopped ones left behind to exit. An owned process that appears meanwhile is stopped as well,
 * up to EXIT_ROUNDS times. Returns every process stopped, those still running and that listing.
 */
async function stopAndReport(classify, settled) {
  const stopped = new Map();
  const find = () => { const remaining = classify()?.owned; for (const entry of remaining ?? []) stopped.set(entry.pid, entry); return remaining; };
  let reported = settled;
  let unstopped = [];
  for (let round = 0; reported?.owned.length > 0 && round < EXIT_ROUNDS; round += 1) {
    for (const entry of reported.owned) stopped.set(entry.pid, entry);
    const { listed, refused, remaining } = await stopRounds(reported.owned, find);
    unstopped = remaining;
    reported = await settle(classify, STOP_GRACE_MS);
    // Stopping again would change nothing only once every process left was read, again and again,
    // and could not be told to be the one listed.
    if (refused && reported && sameProcesses(reported.owned, listed)) break;
  }
  if (reported) {
    const pids = new Set(reported.owned.map((entry) => entry.pid));
    unstopped = [...reported.owned, ...unstopped.filter((entry) => !pids.has(entry.pid) && mayRun(entry))];
  }
  for (const entry of unstopped) stopped.set(entry.pid, entry);
  return { owned: [...stopped.values()], unstopped, reported };
}

/** Entries left in a temp folder, ignoring tool caches and the guard's own records. */
export function tempLeftovers(directory) {
  try { return readdirSync(directory).filter((name) => !isToolCache(name) && !isGuardRecord(name)).sort(); } catch { return []; }
}

/** Removes a directory tree, first making read-only folders in it writable again. */
export function removeTree(directory) {
  try { rmSync(directory, { recursive: true, force: true, maxRetries: 3 }); return true; } catch { /* retried below */ }
  const unlock = (target) => {
    try {
      if (!lstatSync(target).isDirectory()) return;
      chmodSync(target, 0o700);
      for (const name of readdirSync(target)) unlock(path.join(target, name));
    } catch { /* gone or not ours */ }
  };
  unlock(directory);
  try { rmSync(directory, { recursive: true, force: true, maxRetries: 3 }); return true; } catch { return false; }
}

const describeProcess = (entry) => {
  const command = entry.command.length > 300 ? `${entry.command.slice(0, 300)}…` : entry.command;
  return `process ${entry.pid} (group ${entry.pgid}${entry.cwd ? `, cwd ${entry.cwd}` : ""}): ${command}`;
};

const describeLock = (lock) => `${lock.directory}, a machine-wide lock held by process ${lock.pid}, which ended without releasing it${lock.kept
  ? "; it was left in place, since another process holds withFileLock's takeover marker for it and may be taking it over"
  : ""}`;

const listed = (items, describe, noun) => [
  ...items.slice(0, MAX_LISTED).map((item) => `  ${describe(item)}`),
  ...(items.length > MAX_LISTED ? [`  …and ${items.length - MAX_LISTED} more ${noun}`] : []),
];

/** The report of a scope's leftovers; `orphans` and `ambiguous` are processes the guard did not stop. */
function report(subject, processes, entries, notes, { worktree, orphans = [], ambiguous = [] } = {}) {
  const lines = [`DevFn test leak guard: ${subject} left these behind.`,
    ...listed(processes, describeProcess, "processes"),
    ...listed(entries, (entry) => `temp entry ${entry}`, "temp entries")];
  if (orphans.length > 0) {
    lines.push(`These processes started during the run, run from or name a path in the worktree ${worktree}, and were orphaned. The guard cannot tell they are this run's, so it has not stopped them:`,
      ...listed(orphans, describeProcess, "processes"));
  }
  if (ambiguous.length > 0) {
    lines.push("These processes name one of the run's temp folders only where the process listing cannot show where that value ends, so it may name another path. The guard cannot tell they are this run's, so it has not stopped them:",
      ...listed(ambiguous, describeProcess, "processes"));
  }
  lines.push(...notes);
  lines.push(`Stop every process a test starts, with its detached process group, and remove every temp directory it creates in teardown (afterEach, afterAll or finally), so failures and timeouts clean up too.${processes.length > 0 || entries.length > 0 ? " The guard has stopped and removed what it attributed to this run." : ""}`);
  return lines.join("\n");
}

function setTempDirectory(directory) {
  for (const name of TEMP_VARIABLES) process.env[name] = directory;
}

function newToken() {
  return randomBytes(8).toString("hex");
}

// Vitest forks its pool workers from the main process, and Vite may start esbuild there:
// those children inherit the run marker but are the runner's own and exit when it closes.
// Vitest retitles them "node (vitest 1)" and so on, which is what ps then shows.
const isRunnerChild = (entry) => entry.ppid === process.pid &&
  (/^node \(vitest(?: \d+)?\)/.test(entry.command) || /[\\/](?:vitest|tinypool|esbuild)[\\/]|[\\/]esbuild(?:\s|$)/.test(entry.command));

/**
 * What one listing holds of a run: the processes it owns, those it cannot tell are its own
 * (ambiguous) and its worktree orphans. Both the run's check and its exit cleanup take all three
 * from the same listing, so a process one class excludes is always in another.
 */
function classifyRun(listing, scope, { worktree, startedAt, root }) {
  const { owned, ambiguous } = attributeProcesses(listing, scope);
  const attributed = new Set([...owned, ...ambiguous].map((entry) => entry.pid));
  return { owned, ambiguous, orphans: worktree ? worktreeOrphans(listing, { worktree, startedAt, attributed, root }) : [] };
}

function composeContainers(roots) {
  if (process.env.DEVFN_REAL_COMPOSE !== "1") return [];
  const listing = run("docker", ["ps", "-a", "--filter", "label=com.docker.compose.project.working_dir", "--format", "{{.ID}}\t{{.Names}}\t{{.Label \"com.docker.compose.project.working_dir\"}}"], 20_000);
  if (!listing || listing.status !== 0) return [];
  return listing.stdout.split("\n").map((line) => line.split("\t")).filter(([id, , directory]) => id && directory && isUnder(directory, roots)).map(([id, name, directory]) => ({ id, name, directory }));
}

/**
 * Vitest global setup: gives the run its own temp root and marker, and returns the
 * teardown that fails the run when anything the run started is still there.
 */
export async function setup(project) {
  const startedAt = Date.now();
  // Vitest keeps a folder of its own in the original temp folder and removes it only when it closes.
  const runnerTemp = typeof project?.tmpDir === "string" ? project.tmpDir : undefined;
  const original = os.tmpdir();
  const root = mkdtempSync(path.join(original, ROOT_PREFIX));
  const rootAliases = pathAliases(root);
  // A run nested in a guarded test keeps the outer run's original temp folder for machine-wide locks.
  process.env[ORIGINAL_TEMP_VARIABLE] ||= original;
  linkToolCaches(root, process.env[ORIGINAL_TEMP_VARIABLE]);
  const marker = `${RUN_MARKER}=${newToken()}`;
  const [name, value] = marker.split("=");
  writeFileSync(path.join(root, RUN_RECORD), JSON.stringify({ pid: process.pid, marker }));
  process.env[name] = value;
  process.env[ROOT_VARIABLE] = root;
  process.env[MAIN_PID_VARIABLE] = String(process.pid);
  setTempDirectory(root);
  // The run's root and every directory its tests registered, read again each time: tests register them as they go.
  const runDirectories = () => registeredDirectories(root);
  const roots = () => [...rootAliases, ...runDirectories().flatMap(pathAliases)];
  // The run's own pool workers and Vite's esbuild are excluded, but not what tests started from them.
  const scope = () => ({ marker, roots: roots(), parent: process.pid, excluded: isRunnerChild });
  const worktree = findWorktree(process.cwd());

  // Shared by the exit cleanup and the teardown. The exit cleanup stays armed until the teardown
  // has finished, so a run interrupted during the teardown (turbo cancelling a package while it
  // waits for processes to exit) still stops, removes and reports everything. `found` holds what
  // the teardown has already found, so that report names it even once it is stopped, and `listed`
  // the teardown's last good classification.
  const state = { cleanedUp: false, tornDown: false, found: { processes: new Map(), entries: new Set() }, listed: undefined };
  // Interrupted runs (Ctrl-C, or turbo stopping sibling tasks after a failure) never reach the
  // teardown, or never finish it, so the process exit stops what the run started and removes its
  // root synchronously.
  const onExit = () => {
    if (state.cleanedUp) return;
    state.cleanedUp = true;
    // Stopping comes before reporting, and no step may keep the next from running: turbo, for
    // one, closes the output pipe of a task it cancels, so writing the report can throw.
    const attempt = (step) => { try { return step(); } catch { return undefined; } };
    const directories = attempt(runDirectories) ?? [];
    const allRoots = [...rootAliases, ...directories.flatMap(pathAliases)];
    // The run is ending, so its own pool workers, which a hung test may keep alive, go too. What it
    // only reports, ambiguous processes and worktree orphans, comes from the latest listing, or
    // from the last one that succeeded when a later one fails.
    // A run interrupted during its teardown starts from what the teardown last listed.
    const classify = keepingLast(() => {
      const listing = listProcesses(startedAt);
      return listing && classifyRun(listing, { marker, roots: allRoots, parent: process.pid }, { worktree, startedAt, root });
    }, () => state.listed);
    let classified = { owned: [], ambiguous: [], orphans: [] };
    const find = () => attempt(() => {
      classified = classify() ?? classified;
      return classified.owned;
    }) ?? [];
    const owned = new Map();
    const held = new Map();
    // A cancelling runner may SIGKILL this process shortly after its signal, so there is no grace.
    // SIGKILL leaves a process no time to start another, but one may have just started; the
    // listing is taken again, a bounded number of times, to stop it too.
    for (let round = 0, pending = find(); pending.length > 0 && round < EXIT_ROUNDS; round += 1) {
      for (const entry of pending) owned.set(entry.pid, entry);
      attempt(() => signalAll(pending, "SIGKILL", held));
      sleepSync(100);
      if (round + 1 < EXIT_ROUNDS) pending = find();
    }
    for (const container of attempt(() => composeContainers(allRoots)) ?? []) attempt(() => run("docker", ["rm", "-f", "-v", container.id], 30_000));
    // A worker killed above may have held a machine-wide lock; this process is exiting too.
    const locks = attempt(() => removeAbandonedLocks(root, { graceMs: 1_000, ending: process.pid })) ?? [];
    // What is left is listed before it is removed, so a temp entry alone also fails the run.
    const leftovers = attempt(() => [...runLeftovers(root), ...directories.filter((directory) => existsSync(directory))]) ?? [];
    const unremoved = [...directories, root].filter((directory) => attempt(() => removeTree(directory)) !== true);
    if (runnerTemp) attempt(() => removeTree(runnerTemp));
    const leaked = new Map(state.found.processes);
    for (const entry of owned.values()) if (!isRunnerChild(entry)) leaked.set(entry.pid, entry);
    for (const entry of held.values()) if (!leaked.has(entry.pid) && attempt(() => mayRun(entry))) leaked.set(entry.pid, entry);
    const entries = [...new Set([...state.found.entries, ...leftovers]), ...locks.map(describeLock), ...unremoved.map((directory) => `${directory}, which could not be removed`)];
    const { ambiguous, orphans } = classified;
    const notes = classify.stale ? [STALE_NOTE] : [];
    // A process signalAll could not tell was still the one listed, or still in its group, was never signalled.
    const unstopped = attempt(() => {
      const kept = [...new Map([...owned, ...held]).values()];
      const states = processStates(kept.map((entry) => entry.pid));
      return kept.filter((entry) => mayRun(entry, states));
    }) ?? [];
    if (unstopped.length > 0) notes.push(unstoppedNote(unstopped));
    if (leaked.size === 0 && entries.length === 0 && ambiguous.length === 0 && orphans.length === 0 && notes.length === 0) return;
    // The run fails even when it is exiting with success, such as through process.exit(0) or
    // Vitest's exit once a teardown outlasts its teardownTimeout.
    if (!process.exitCode) process.exitCode = 1;
    // The process is exiting, so only a synchronous write reaches a piped stderr.
    attempt(() => writeSync(2, `${report("This interrupted test run", [...leaked.values()], entries, notes, { worktree, orphans, ambiguous })}\n`));
  };
  const onSignal = (signal) => {
    onExit();
    process.off(signal, onSignal);
    // Leave the exit to Vitest when it handles the signal; otherwise end the way Node would have.
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  // Vitest's own signal and exit listeners call process.exit(), which skips any listener after
  // them, so these go first.
  process.prependListener("exit", onExit);
  for (const signal of signals) process.prependListener(signal, onSignal);
  const disarm = () => {
    process.off("exit", onExit);
    for (const signal of signals) process.off(signal, onSignal);
  };

  return async function teardown() {
    if (state.tornDown) return;
    state.tornDown = true;
    try {
      // The exit cleanup has already run: the run was interrupted and the process is exiting.
      if (state.cleanedUp) return;
      await check();
    } finally {
      // Only now, whether the check passed or threw, is there nothing left for the exit cleanup to do.
      state.cleanedUp = true;
      disarm();
    }
  };

  async function check() {
    const found = (processes) => { for (const entry of processes) state.found.processes.set(entry.pid, entry); return processes; };
    const notes = [];
    const classify = keepingLast(() => {
      const listing = listProcesses(startedAt);
      if (!listing) return undefined;
      const classified = classifyRun(listing, scope(), { worktree, startedAt, root });
      found(classified.owned);
      state.listed = classified;
      return classified;
    });
    const listed = classify();
    if (!listed) notes.push(`Processes were not checked: the guard cannot list processes on ${process.platform}.`);
    const none = { owned: [], ambiguous: [], orphans: [] };
    // Every process the run left, those the guard only reports too, gets the same while to exit.
    const settled = listed ? await settle(classify, RUN_GRACE_MS, listed) : none;
    // Everything stopped, including what a stopping process started, is reported.
    const { owned, unstopped, reported } = await stopAndReport(classify, settled);
    const { ambiguous, orphans } = reported ?? none;
    if (unstopped.length > 0) notes.push(unstoppedNote(unstopped));
    if (classify.stale) notes.push(STALE_NOTE);
    // Every test has finished, so a lock this run's processes still hold, this one included, is abandoned.
    const locks = removeAbandonedLocks(root, { graceMs: STOP_GRACE_MS, ending: process.pid });
    for (const lock of locks) state.found.entries.add(describeLock(lock));
    const containers = composeContainers(roots());
    for (const container of containers) run("docker", ["rm", "-f", "-v", container.id], 30_000);
    const entries = runLeftovers(root);
    // A file's own check removes the directories it registered; one still here escaped it.
    for (const directory of runDirectories()) {
      if (!existsSync(directory)) continue;
      entries.push(directory);
      if (!removeTree(directory)) notes.push(`The directory ${directory} could not be removed.`);
    }
    entries.push(...locks.map(describeLock));
    for (const container of containers) entries.push(`compose container ${container.name} (${container.id}) for ${container.directory}`);
    for (const entry of entries) state.found.entries.add(entry);
    // A root the guard cannot remove stays in the temp folder, so it fails the run like any other leftover.
    const rootRemoved = removeTree(root);
    if (!rootRemoved) entries.push(`${root}, the run's temp root, which could not be removed`);
    if (owned.length > 0 || entries.length > 0 || unstopped.length > 0 || orphans.length > 0 || ambiguous.length > 0 || classify.stale) {
      // Failing here ends Vitest's close before it removes its own folder, so remove it now.
      if (runnerTemp) removeTree(runnerTemp);
      throw new Error(report(`This test run (temp root ${root})`, owned, entries, notes, { worktree, orphans, ambiguous }));
    }
    if (notes.length > 0) process.stderr.write(`${notes.join("\n")}\n`);
  }
}

/**
 * The temp entries left in a run's root. A folder the guard made for a test file, as recorded
 * in the root, is listed by its contents; any other entry, whatever its name, is listed itself.
 */
function runLeftovers(root) {
  let folders;
  try { folders = new Set(readFileSync(path.join(root, FOLDER_RECORD), "utf8").split("\n")); } catch { folders = new Set(); }
  const isFileFolder = (entry) => { try { return folders.has(entry) && lstatSync(path.join(root, entry)).isDirectory(); } catch { return false; } };
  return tempLeftovers(root).flatMap((entry) => {
    const nested = isFileFolder(entry) ? tempLeftovers(path.join(root, entry)).map((inner) => `${entry}/${inner}`) : [entry];
    return nested.map((relative) => path.join(root, relative));
  });
}

const GUARDED_DIRECTORIES = Symbol.for("superfunctions.testLeakGuard.directories");

/**
 * Adds a directory outside the temp folder, such as one under the package's node_modules, to
 * the current test file's guard: processes running from it or naming it count as the file's,
 * and the directory must be gone once the file's own hooks have run.
 */
export function guardDirectory(directory) {
  const resolved = path.resolve(directory);
  (globalThis[GUARDED_DIRECTORIES] ??= new Set()).add(resolved);
  // Recorded in the run's root as well, before the test starts anything there, so the run's own
  // check, and its cleanup when it is interrupted, cover the directory even once this worker is gone.
  const root = process.env[ROOT_VARIABLE];
  if (root) appendFileSync(path.join(root, DIRECTORY_RECORD), `${JSON.stringify(resolved)}\n`);
}

/** The directories the tests of the run with the given root registered with guardDirectory. */
function registeredDirectories(root) {
  let text;
  try { text = readFileSync(path.join(root, DIRECTORY_RECORD), "utf8"); } catch { return []; }
  const directories = new Set();
  for (const line of text.split("\n")) {
    try { if (line) directories.add(JSON.parse(line)); } catch { /* a line another worker is still writing */ }
  }
  return [...directories];
}

/**
 * Records, in the current run's root, that this process is about to take the machine-wide lock
 * at `lockPath` (shared-locks.mjs). Such a lock lives outside the run's temp root, so when the
 * process holding it is killed before it releases the lock (an interrupted run, or a worker
 * stopped at the run's end), the run's cleanup finds it here.
 */
export function recordMachineLock(lockPath) {
  const root = process.env[ROOT_VARIABLE];
  if (!root) return;
  try { appendFileSync(path.join(root, LOCK_RECORD), `${JSON.stringify({ lock: path.resolve(lockPath), pid: process.pid, at: Date.now() })}\n`); }
  catch { /* the run has ended; there is nothing left to clean up for */ }
}

/** The machine-wide locks the run's tests named: each lock with the processes that named it and when each first did. */
function recordedLocks(root) {
  let text;
  try { text = readFileSync(path.join(root, LOCK_RECORD), "utf8"); } catch { return new Map(); }
  const locks = new Map();
  for (const line of text.split("\n")) {
    let entry;
    try { entry = line ? JSON.parse(line) : undefined; } catch { continue; /* a line another worker is still writing */ }
    if (typeof entry?.lock !== "string" || !Number.isSafeInteger(entry.pid) || !Number.isFinite(entry.at)) continue;
    const namers = locks.get(entry.lock) ?? new Map();
    namers.set(entry.pid, Math.min(namers.get(entry.pid) ?? Infinity, entry.at));
    locks.set(entry.lock, namers);
  }
  return locks;
}

/**
 * The locks, and released locks not yet removed (`<lock>.released.<token>`, as withFileLock in
 * @devfn/ports leaves one when killed between moving and removing it), that a process of this run
 * holds: the owner record names a process that named that lock in this run and took it after
 * doing so. Anything else, such as a lock of another run or of a process that is still running
 * elsewhere, is not this run's.
 */
function runLocks(root) {
  const held = [];
  for (const [lock, namers] of recordedLocks(root)) {
    const parent = path.dirname(lock);
    const base = path.basename(lock);
    let names;
    try { names = readdirSync(parent); } catch { continue; }
    for (const name of names) {
      if (name !== base && !name.startsWith(`${base}.released.`)) continue;
      const directory = path.join(parent, name);
      let record;
      let owner;
      try { record = readFileSync(path.join(directory, "owner.json"), "utf8"); owner = JSON.parse(record); } catch { continue; }
      const pid = owner?.pid;
      const created = Date.parse(owner?.createdAt);
      if (!Number.isSafeInteger(pid) || !namers.has(pid) || Number.isNaN(created) || created < namers.get(pid)) continue;
      held.push({ directory, released: name !== base, pid, record });
    }
  }
  return held;
}

/** The IDs of the processes still running, without zombies, or undefined where they cannot be listed. */
function runningPids() {
  if (process.platform === "linux") {
    let names;
    try { names = readdirSync("/proc"); } catch { return undefined; }
    return new Set(names.filter((name) => /^\d+$/.test(name)).flatMap((name) => {
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        return /^[ZX]/.test(stat.slice(stat.lastIndexOf(")") + 2)) ? [] : [Number(name)];
      } catch { return []; }
    }));
  }
  if (process.platform !== "darwin") return undefined;
  const listing = run("ps", ["-A", "-o", "pid=", "-o", "stat="]);
  if (!listing || listing.status !== 0) return undefined;
  return new Set(listing.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\S+)/.exec(line);
    return match && !match[2].startsWith("Z") ? [Number(match[1])] : [];
  }));
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * withFileLock's takeover marker prefix for an owner record. @devfn/ports src/lock.ts
 * (recoverLock) is the source of truth for this format: a waiter taking over a dead holder's lock
 * links `owner.takeover.<first 32 hex digits of the record's SHA-256>.<generation>`, and links
 * generation n+1 only once the taker of n is dead, so only the newest taker of a record may be live.
 */
const takeoverPrefix = (record) => `owner.takeover.${createHash("sha256").update(record).digest("hex").slice(0, 32)}.`;

/**
 * A process's birth signature exactly as processBirthSignature (@devfn/config) reads it, so
 * withFileLock can tell a reused process ID from the process that wrote a record. Undefined
 * when it cannot be read.
 */
function birthSignature(pid) {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const start = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
      return start ? `linux:${start}` : undefined;
    } catch { return undefined; }
  }
  if (process.platform !== "darwin") return undefined;
  const start = run("ps", ["-o", "lstart=", "-p", String(pid)], 15_000, UTC_TOOL_ENV())?.stdout.trim();
  return start ? `darwin-utc:${start}` : undefined;
}

/**
 * Whether a takeover marker records a taker that is no longer running: its process is gone, or
 * its process ID now belongs to a process with another birth signature. One that cannot be read
 * may still be live.
 */
function takerDead(marker) {
  let owner;
  try { owner = JSON.parse(readFileSync(marker, "utf8")); } catch { return false; }
  // Only a record withFileLock itself accepts (parseOwnerRecord in @devfn/ports src/lock.ts) can show its taker dead.
  if (typeof owner !== "object" || owner === null || Array.isArray(owner) || typeof owner.token !== "string" || owner.token === "") return false;
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.createdAt !== "string" || Number.isNaN(Date.parse(owner.createdAt))) return false;
  if (owner.birthSignature !== undefined && typeof owner.birthSignature !== "string") return false;
  const running = runningPids();
  if (running ? !running.has(owner.pid) : !alive(owner.pid)) return true;
  const current = typeof owner.birthSignature === "string" ? birthSignature(owner.pid) : undefined;
  return current !== undefined && current.split(":")[0] === owner.birthSignature.split(":")[0] && current !== owner.birthSignature;
}

let ownSignature;
const ownBirthSignature = () => (ownSignature ??= birthSignature(process.pid));

// Test-only: set to a file path, the guard writes `<path>.held` once it holds a lock's takeover
// marker and waits, up to 30 s, for `<path>` to exist, so a self-test can interleave a waiter.
const LOCK_PAUSE_VARIABLE = "SFN_TEST_LEAK_GUARD_LOCK_PAUSE";

function pauseForTest(marker) {
  const pauseFile = process.env[LOCK_PAUSE_VARIABLE];
  if (!pauseFile) return;
  writeFileSync(`${pauseFile}.held`, JSON.stringify({ pid: process.pid, marker }));
  for (const deadline = Date.now() + 30_000; !existsSync(pauseFile) && Date.now() < deadline;) sleepSync(20);
}

/**
 * Moves a dead holder's lock to `target` under withFileLock's own takeover protocol, as a waiter
 * recovering it would: it links the record's next takeover marker with an owner record of its
 * own, passing a generation only when its taker is dead, then, holding that marker, moves the
 * lock only while its owner record is still the one the guard read. No waiter can take the lock
 * over meanwhile, and the move frees its path in one step. Returns "moved", "busy" when another
 * taker may be live (the lock is left to it) or "changed" when it was released or replaced.
 */
function moveAbandonedLock({ directory, record }, target) {
  const token = `leak-guard-${newToken()}`;
  const temp = path.join(directory, `owner.${token}.tmp`);
  const snapshot = path.join(directory, `owner.snapshot.${token}`);
  const prefix = takeoverPrefix(record);
  let marker;
  try {
    // With a birth signature, as withFileLock's own record has, so that once this process is gone
    // a waiter counts the marker's taker dead even after its process ID is reused.
    writeFileSync(temp, JSON.stringify({ token, pid: process.pid, birthSignature: ownBirthSignature(), createdAt: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
    for (let generation = 0; marker === undefined; generation += 1) {
      const candidate = path.join(directory, `${prefix}${generation}`);
      try { linkSync(temp, candidate); marker = candidate; }
      catch (error) {
        if (error?.code !== "EEXIST") throw error;
        if (!takerDead(candidate)) return "busy";
      }
    }
    pauseForTest(marker);
    linkSync(path.join(directory, "owner.json"), snapshot);
    if (readFileSync(snapshot, "utf8") !== record) return "changed";
    renameSync(directory, target);
    return "moved";
  } catch (error) {
    return error?.code === "ENOENT" ? "changed" : "busy";
  } finally {
    // Once moved, these files go with the lock; otherwise only the guard's own files go.
    if (!existsSync(target)) for (const file of [temp, snapshot, marker]) if (file) try { rmSync(file, { force: true }); } catch { /* left for the next taker to judge */ }
  }
}

/**
 * Removes the locks a process of this run took and died holding, once it has died: this runs
 * after the run's own processes were stopped, and waits up to `graceMs` for them to go. A lock
 * whose holder is still running, or that this run's processes never took, is left alone.
 * `ending` names a process to count as gone although it is still running, such as this one
 * when it is about to exit. Synchronous, so it can run as the process exits.
 *
 * withFileLock lets any waiter take over a dead holder's lock once it is `staleMs` old, replacing
 * its owner record in place, and excludes other takers only through its takeover markers. So the
 * guard moves a lock away only while holding such a marker itself (moveAbandonedLock). A lock
 * another live taker holds a marker for is left in place and listed as kept, so the run still
 * fails. A released copy (`<lock>.released.*`) is never taken over, so it goes as it is.
 */
function removeAbandonedLocks(root, { graceMs, ending } = {}) {
  const held = runLocks(root);
  if (held.length === 0) return [];
  let running = runningPids();
  // Without a listing, a zombie still counts as running, so nothing is removed that may be live.
  const dead = (pid) => pid === ending || (running ? !running.has(pid) : !alive(pid));
  for (const deadline = Date.now() + (graceMs ?? 0); held.some((lock) => !dead(lock.pid)) && Date.now() < deadline;) {
    sleepSync(50);
    running = runningPids();
  }
  const removed = [];
  for (const lock of runLocks(root).filter((candidate) => dead(candidate.pid))) {
    const target = lock.released ? lock.directory : `${lock.directory}.released.leak-guard-${newToken()}`;
    const outcome = lock.released ? "moved" : moveAbandonedLock(lock, target);
    if (outcome === "busy") removed.push({ ...lock, kept: true });
    if (outcome !== "moved") continue;
    removeTree(target);
    removed.push(lock);
  }
  return removed;
}

/** The nearest directory at or above `start` that holds a `.git` entry, or undefined. */
function findWorktree(start) {
  for (let directory = path.resolve(start); ; directory = path.dirname(directory)) {
    if (existsSync(path.join(directory, ".git"))) return directory;
    if (path.dirname(directory) === directory) return undefined;
  }
}

/**
 * Other guarded runs that are still going and share this run's temp folder, such as the sibling
 * packages turbo runs alongside this one: the paths and marker that make a process theirs.
 */
function liveSiblingRuns(root) {
  const parent = path.dirname(root);
  let names;
  try { names = readdirSync(parent); } catch { return []; }
  return names.filter((name) => name.startsWith(ROOT_PREFIX) && path.join(parent, name) !== root).flatMap((name) => {
    const sibling = path.join(parent, name);
    try {
      const { pid, marker } = JSON.parse(readFileSync(path.join(sibling, RUN_RECORD), "utf8"));
      if (!Number.isSafeInteger(pid) || typeof marker !== "string" || !alive(pid)) return [];
      return [{ marker, roots: [sibling, ...registeredDirectories(sibling)].flatMap(pathAliases) }];
    } catch { return []; }
  });
}

/**
 * Processes the run cannot attribute but must report: started since the run began, running from
 * or naming a path in the worktree (one in a macOS listing too, even the worktree itself cut short
 * at a separator, unless an entry beside it continues the name there, as `<worktree> copy/x` with
 * `<worktree> copy` existing), and orphaned, that is re-parented to init or a subreaper
 * along a chain of processes that also started during the run. A process whose chain reaches this
 * run's process or one of its ancestors, such as a sibling task under the same turbo, or a
 * process that was already running, such as an editor, is someone else's. So is one that a live
 * sibling guarded run attributes to itself, or one in `attributed`, the processes the run owns or
 * reports as ambiguous from the same listing.
 */
function worktreeOrphans(processes, { worktree, startedAt, attributed, root }) {
  const window = Math.ceil((Date.now() - startedAt) / 1000);
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const ancestors = ancestorsOf(process.pid, processes);
  const recent = (entry) => entry.elapsed !== undefined && entry.elapsed <= window;
  const orphaned = (entry) => {
    const seen = new Set();
    for (let current = entry; !seen.has(current.pid);) {
      seen.add(current.pid);
      if (current.ppid <= 1) return true;
      const parent = byPid.get(current.ppid);
      // A subreaper such as `systemd --user` may be this run's ancestor too.
      if (parent && isReaper(parent)) return true;
      if (!parent || current.ppid === process.pid || ancestors.has(current.ppid) || !recent(parent)) return false;
      current = parent;
    }
    return false;
  };
  const siblings = liveSiblingRuns(root);
  const worktreeRoots = pathAliases(worktree);
  const checkouts = new Map();
  // A cut match names a path outside the worktree, such as the sibling `<worktree> copy` beside
  // it, only when such a path exists and no path in the worktree that it may name, other than
  // the worktree itself, does; otherwise it may name the worktree.
  const inThisWorktree = (named, worktreeRoot, match) => !inNestedCheckout(named, worktreeRoot, checkouts) &&
    !(match?.cut && match.besides.some((beside) => existsSync(beside)) && !match.within.some((inside) => existsSync(inside)));
  return processes.filter((entry) => entry.pid !== process.pid && !ancestors.has(entry.pid) && !attributed.has(entry.pid) && recent(entry) &&
    namesPathUnder(entry, worktreeRoots, inThisWorktree) !== undefined && !/\bturbo(?:\.exe)?\b.*\bdaemon\b/.test(entry.command) &&
    !siblings.some((sibling) => entry.environment.includes(sibling.marker) || namesPathUnder(entry, sibling.roots)) && orphaned(entry));
}

const guardedDirectories = () => [...(globalThis[GUARDED_DIRECTORIES] ?? [])];

/** The IDs of every running process, cheaply, to tell which processes a test started. */
function listPids() {
  if (process.platform === "linux") {
    try { return new Set(readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map(Number)); } catch { return undefined; }
  }
  if (process.platform !== "darwin") return undefined;
  const listing = run("ps", ["-A", "-o", "pid="]);
  return listing && listing.status === 0 ? new Set(listing.stdout.split("\n").filter((line) => line.trim()).map(Number)) : undefined;
}

/**
 * Per-test-file guard, called from a Vitest setup file with that file's hooks. The file's temp
 * directories go to a folder of their own.
 *
 * When a test fails or times out, its own cleanup may not have run: a `finally` waits for the
 * stalled call. So after such a test the guard stops every process of this file that the test
 * started (with the detached group it leads) and removes the temp entries it created. A passing
 * test is left alone, since a test may share a process or folder with the next one. Tests in a
 * file are assumed to run one at a time; a concurrent test is left to the file's check.
 *
 * After the file's own hooks, the guard fails the file if any process it started is still
 * running or any temp entry remains, then stops and removes them.
 */
export function guardTestFile({ beforeEach, afterEach, afterAll }) {
  const root = process.env[ROOT_VARIABLE];
  // Without the global setup (a custom config) there is no run to attribute leftovers to.
  if (!root) return;
  const startedAt = Date.now();
  const folder = mkdtempSync(path.join(root, FILE_PREFIX));
  // Recorded at once, so the run lists this folder by its contents, and lists as itself any other entry.
  appendFileSync(path.join(root, FOLDER_RECORD), `${path.basename(folder)}\n`);
  linkToolCaches(folder, process.env[ORIGINAL_TEMP_VARIABLE]);
  const folderRoots = pathAliases(folder);
  globalThis[GUARDED_DIRECTORIES] = new Set();
  // In Vitest's forks pool this file runs in a worker process of its own, so every process the
  // worker started is the file's. In the threads pool the process is the runner's, shared with other files.
  const worker = process.env[MAIN_PID_VARIABLE] !== String(process.pid) ? process.pid : undefined;
  const scope = () => ({ marker, roots: [...folderRoots, ...guardedDirectories().flatMap(pathAliases)], parent: worker });
  const marker = `${FILE_MARKER}=${newToken()}`;
  const [name, value] = marker.split("=");
  process.env[name] = value;
  setTempDirectory(folder);

  let before;
  // What the stop after a failed test left running, which the file's check lists even when it no
  // longer finds it as the file's, such as a process held back in an exited leader's group.
  const leftBehind = new Map();
  // Setup-file hooks are registered first: Vitest runs these before-hooks before the file's own,
  // and these after-hooks after the file's own.
  beforeEach(() => { before = { at: Date.now(), pids: listPids(), entries: new Set(tempLeftovers(folder)) }; });
  afterEach(async (context) => {
    // Tests that run concurrently share the snapshot, so what each started cannot be told apart.
    if (context?.task?.result?.state !== "fail" || context.task.concurrent || !before?.pids) return;
    const { at, pids, entries } = before;
    const find = () => { const listed = listProcesses(at); return listed && ownedProcesses(listed, scope()).filter((entry) => !pids.has(entry.pid)); };
    const started = find() ?? [];
    if (started.length > 0) for (const entry of await stopProcesses(started, find)) leftBehind.set(entry.pid, entry);
    for (const entry of tempLeftovers(folder)) if (!entries.has(entry)) removeTree(path.join(folder, entry));
  }, 60_000);
  afterAll(async (suite) => {
    const classify = keepingLast(() => { const listing = listProcesses(startedAt); return listing && attributeProcesses(listing, scope()); });
    // Ambiguous processes, which the guard only reports, get the same while to exit as owned ones.
    const settled = await settle(classify, FILE_GRACE_MS) ?? { owned: [], ambiguous: [] };
    const { owned, unstopped, reported } = await stopAndReport(classify, settled);
    const pids = new Set(owned.map((entry) => entry.pid));
    for (const entry of leftBehind.values()) {
      if (pids.has(entry.pid) || !mayRun(entry)) continue;
      owned.push(entry);
      unstopped.push(entry);
    }
    const ambiguous = reported?.ambiguous ?? [];
    const entries = tempLeftovers(folder).map((entry) => path.join(folder, entry));
    const removed = removeTree(folder);
    for (const directory of guardedDirectories()) {
      if (!existsSync(directory)) continue;
      entries.push(directory);
      removeTree(directory);
    }
    const notes = [];
    if (unstopped.length > 0) notes.push(unstoppedNote(unstopped));
    if (classify.stale) notes.push(STALE_NOTE);
    if (!removed) entries.push(`${folder}, the test file's temp folder, which could not be removed`);
    if (owned.length > 0 || entries.length > 0 || ambiguous.length > 0 || classify.stale) {
      // The absolute path, the same on every platform and from every working directory.
      throw new Error(report(suite?.filepath ?? "This test file", owned, entries, notes, { ambiguous }));
    }
  }, 60_000);
}
