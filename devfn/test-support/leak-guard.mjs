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
import { appendFileSync, chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
// and the machine-wide locks its tests named (shared-locks.mjs).
const RUN_RECORD = ".leak-guard-run.json";
const DIRECTORY_RECORD = ".leak-guard-directories";
const LOCK_RECORD = ".leak-guard-locks";
const isGuardRecord = (name) => name === RUN_RECORD || name === DIRECTORY_RECORD || name === LOCK_RECORD;
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

const isUnder = (candidate, roots) => roots.some((root) => candidate === root || candidate.startsWith(`${root}/`));

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
    processes.push({ pid, ppid: Number(fields[1]), pgid: Number(fields[2]), elapsed, command: argv.replaceAll("\0", " ").trim(), argv, environment: read("environ"), separated: true, cwd });
  }
  return processes;
}

function listDarwin(sinceMs) {
  const columns = ["-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "etime=", "-o", "stat=", "-o", "command="];
  const plain = run("ps", ["-A", "-ww", ...columns]);
  // -E appends each process's initial environment to its command; it is read only to find the marker.
  const withEnvironment = run("ps", ["-A", "-ww", "-E", ...columns]);
  if (!plain || plain.status !== 0 || !withEnvironment) return undefined;
  const parse = (output) => new Map(output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s(.*)$/.exec(line);
    return match ? [[Number(match[1]), { ppid: Number(match[2]), pgid: Number(match[3]), elapsed: elapsedSeconds(match[4]), state: match[5], text: match[6] }]] : [];
  }));
  const commands = parse(plain.stdout);
  const environments = parse(withEnvironment.stdout);
  const processes = [];
  for (const [pid, entry] of commands) {
    // The listing shows the ps that made it, a child of this process.
    if (entry.state.startsWith("Z") || pid === plain.pid || pid === withEnvironment.pid) continue;
    const full = environments.get(pid)?.text ?? "";
    processes.push({ pid, ppid: entry.ppid, pgid: entry.pgid, elapsed: entry.elapsed, command: entry.text.trim(), environment: full.startsWith(entry.text) ? full.slice(entry.text.length) : "", cwd: undefined });
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
const isValuePrefix = (text) => text.endsWith(LIST_SEPARATOR) || /^(?:[^/=:]*=)?(?:file:\/\/)?$/.test(text);

/** The value without trailing slashes, keeping a lone `/`. Linear, unlike a trailing-slash regex. */
function trimTrailingSlashes(value) {
  let end = value.length;
  while (end > 1 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

const isPathUnder = (value, root) => value === root || value.startsWith(`${root}/`);

/** The values of a NUL-separated /proc listing that may be paths. */
function separatedValues(text, environment) {
  return text.split("\0").flatMap((field) => {
    if (!environment) return [field.replace(ASSIGNMENT, "")];
    const at = field.indexOf("=");
    if (at <= 0) return [];
    const value = field.slice(at + 1);
    return LIST_VARIABLES.has(field.slice(0, at)) ? value.split(LIST_SEPARATOR) : [value];
  }).map((value) => trimTrailingSlashes(value.replace(/^file:\/\//, "")));
}

/**
 * The paths at or under `root` that `text` names, each `ambiguous` when it comes from a
 * space-joined listing, which cannot show where a value starts or ends, and `cut` when it is
 * `root` itself cut short there at a separator (`<root> copy/x` lists as `<root>`).
 */
function namedPaths(text, root, { separated = false, environment = false } = {}) {
  if (separated) return separatedValues(text, environment).filter((value) => isPathUnder(value, root)).map((value) => ({ path: value, ambiguous: false }));
  const paths = [];
  for (let at = text.indexOf(root); at !== -1; at = text.indexOf(root, at + 1)) {
    let start = at;
    while (start > 0 && !SEPARATOR.test(text[start - 1])) start -= 1;
    if (!isValuePrefix(text.slice(start, at))) continue;
    // From the end of `root`, so a root with a space in it still matches.
    let end = at + root.length;
    while (end < text.length && !SEPARATOR.test(text[end]) && text[end] !== LIST_SEPARATOR) end += 1;
    const value = trimTrailingSlashes(text.slice(at, end));
    if (isPathUnder(value, root)) paths.push({ path: value, ambiguous: true, cut: end === at + root.length && end < text.length });
  }
  return paths;
}

/**
 * The paths at or under `root` that `text` names. With `separated`, the text is NUL-separated,
 * as Linux's /proc keeps it, and `environment` says it holds variables rather than arguments.
 */
export function pathsNamedUnder(text, root, options) {
  return namedPaths(text, root, options).map(({ path: named }) => named);
}

/**
 * How a process names a path under the given roots in its command, environment or working
 * directory: "exact", "ambiguous" when its only such values come from a space-joined listing,
 * "cut" when each of those is the root itself cut short at a separator, or undefined.
 * `accept(path, root)` can reject a named path, such as one inside a nested checkout.
 */
function namesPathUnder(entry, roots, accept = () => true) {
  let found;
  for (const root of roots) {
    if (entry.cwd !== undefined && isPathUnder(entry.cwd, root) && accept(entry.cwd, root)) return "exact";
    const named = [
      ...namedPaths(entry.argv ?? entry.command, root, { separated: entry.separated }),
      ...namedPaths(entry.environment, root, { separated: entry.separated, environment: true }),
    ].filter(({ path: value }) => accept(value, root));
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
  for (let directory = candidate; directory !== root && directory.startsWith(`${root}/`); directory = path.dirname(directory)) {
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
 * Signals each process. A process that leads its own group (a detached wrapper) is signalled with
 * its whole group, which holds only what it started, even once the leader itself has exited: what
 * it started on its way out is still in that group. Any other process is signalled on its own,
 * and only while it is still running, so a reused process ID is not hit.
 */
function signalAll(processes, signal) {
  const group = ownProcessGroup();
  for (const entry of processes) {
    const leads = entry.pgid === entry.pid && entry.pgid !== group;
    if (!leads && !alive(entry.pid)) continue;
    try { process.kill(leads ? -entry.pid : entry.pid, signal); } catch { /* ESRCH: already gone */ }
  }
}

async function waitForExit(processes, graceMs) {
  for (const deadline = Date.now() + graceMs; Date.now() < deadline && processes.some((entry) => alive(entry.pid));) await pause(100);
}

/**
 * Stops the given processes: SIGTERM to each (its group when it leads one), then SIGKILL to each
 * and to every group one of them led. A process may start another as it stops, such as a
 * wrapper's SIGTERM handler, so with `find`, which lists the scope's processes again, it keeps
 * killing whatever the scope still holds until nothing is left or STOP_DEADLINE_MS has passed.
 * Returns the processes still running: what `find` still lists, or else those of the given ones
 * still alive.
 */
export async function stopProcesses(processes, find) {
  const deadline = Date.now() + STOP_DEADLINE_MS;
  signalAll(processes, "SIGTERM");
  await waitForExit(processes, STOP_GRACE_MS);
  for (let pending = processes; ;) {
    // Stragglers found by listing again started while the scope was stopping, so they get no grace.
    signalAll(pending, "SIGKILL");
    await waitForExit(pending, STOP_GRACE_MS);
    if (!find) return pending.filter((entry) => alive(entry.pid));
    const remaining = find() ?? pending.filter((entry) => alive(entry.pid));
    if (remaining.length === 0 || Date.now() >= deadline) return remaining;
    pending = remaining;
  }
}

/** Waits up to `graceMs` for owned processes to exit by themselves and returns those still running. */
async function settle(find, graceMs) {
  let owned = find();
  for (const deadline = Date.now() + graceMs; owned && owned.length > 0 && Date.now() < deadline; owned = find()) await pause(200);
  return owned;
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
  // the teardown has already found, so that report names it even once it is stopped.
  const state = { cleanedUp: false, tornDown: false, found: { processes: new Map(), entries: new Set() } };
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
    // The run is ending, so its own pool workers, which a hung test may keep alive, go too.
    let ambiguous = [];
    const find = () => attempt(() => {
      const attributed = attributeProcesses(listProcesses(startedAt) ?? [], { marker, roots: allRoots, parent: process.pid });
      ({ ambiguous } = attributed);
      return attributed.owned;
    }) ?? [];
    const owned = new Map();
    // A cancelling runner may SIGKILL this process shortly after its signal, so there is no grace.
    // SIGKILL leaves a process no time to start another, but one may have just started; the
    // listing is taken again, a bounded number of times, to stop it too.
    for (let round = 0, pending = find(); pending.length > 0 && round < EXIT_ROUNDS; round += 1) {
      for (const entry of pending) owned.set(entry.pid, entry);
      attempt(() => signalAll(pending, "SIGKILL"));
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
    const entries = [...new Set([...state.found.entries, ...leftovers]), ...locks.map(describeLock), ...unremoved.map((directory) => `${directory}, which could not be removed`)];
    if (leaked.size === 0 && entries.length === 0 && ambiguous.length === 0) return;
    // The run fails even when it is exiting with success, such as through process.exit(0) or
    // Vitest's exit once a teardown outlasts its teardownTimeout.
    if (!process.exitCode) process.exitCode = 1;
    // The process is exiting, so only a synchronous write reaches a piped stderr.
    attempt(() => writeSync(2, `${report("This interrupted test run", [...leaked.values()], entries, [], { ambiguous })}\n`));
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
    const listed = listProcesses(startedAt);
    if (!listed) notes.push(`Processes were not checked: the guard cannot list processes on ${process.platform}.`);
    // The latest listing, from which processes the guard could not attribute are reported.
    let latest = listed;
    const find = () => { latest = listProcesses(startedAt); return latest && found(ownedProcesses(latest, scope())); };
    const settled = listed ? await settle(find, RUN_GRACE_MS) ?? [] : [];
    // Everything stopped, including what a stopping process started, is reported.
    const stopped = new Map(settled.map((entry) => [entry.pid, entry]));
    const unstopped = settled.length > 0 ? await stopProcesses(settled, () => { const remaining = find(); for (const entry of remaining ?? []) stopped.set(entry.pid, entry); return remaining; }) : [];
    const owned = [...stopped.values()];
    if (unstopped.length > 0) notes.push(`Still running after SIGKILL: ${unstopped.map((entry) => entry.pid).join(", ")}.`);
    // Every test has finished, so a lock this run's processes still hold, this one included, is abandoned.
    const locks = removeAbandonedLocks(root, { graceMs: STOP_GRACE_MS, ending: process.pid });
    for (const lock of locks) state.found.entries.add(describeLock(lock));
    const orphans = listed && worktree ? await settle(() => worktreeOrphans(listProcesses(startedAt) ?? [], { worktree, startedAt, own: scope(), root }), STOP_GRACE_MS) ?? [] : [];
    const ambiguous = latest ? attributeProcesses(latest, scope()).ambiguous : [];
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
    if (owned.length > 0 || entries.length > 0 || unstopped.length > 0 || orphans.length > 0 || ambiguous.length > 0) {
      // Failing here ends Vitest's close before it removes its own folder, so remove it now.
      if (runnerTemp) removeTree(runnerTemp);
      throw new Error(report(`This test run (temp root ${root})`, owned, entries, notes, { worktree, orphans, ambiguous }));
    }
    if (notes.length > 0) process.stderr.write(`${notes.join("\n")}\n`);
  }
}

/** The temp entries left in a run's root; a file's folder is listed by its contents. */
function runLeftovers(root) {
  return tempLeftovers(root).flatMap((entry) => {
    const nested = entry.startsWith(FILE_PREFIX) ? tempLeftovers(path.join(root, entry)).map((inner) => `${entry}/${inner}`) : [entry];
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
  const start = run("ps", ["-o", "lstart=", "-p", String(pid)], 15_000, { ...toolEnv(), TZ: "UTC0" })?.stdout.trim();
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
 * or naming a path in the worktree (one in a macOS listing too, unless it is only the worktree
 * itself cut short at a separator, as `<worktree> copy/x` lists), and orphaned, that is re-parented to init or a subreaper
 * along a chain of processes that also started during the run. A process whose chain reaches this
 * run's process or one of its ancestors, such as a sibling task under the same turbo, or a
 * process that was already running, such as an editor, is someone else's. So is one that a live
 * sibling guarded run attributes to itself.
 */
function worktreeOrphans(processes, { worktree, startedAt, own, root }) {
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
  const { owned, ambiguous } = attributeProcesses(processes, own);
  const ownPids = new Set([...owned, ...ambiguous].map((entry) => entry.pid));
  const siblings = liveSiblingRuns(root);
  const worktreeRoots = pathAliases(worktree);
  const checkouts = new Map();
  const inThisWorktree = (named, worktreeRoot) => !inNestedCheckout(named, worktreeRoot, checkouts);
  return processes.filter((entry) => entry.pid !== process.pid && !ancestors.has(entry.pid) && !ownPids.has(entry.pid) && recent(entry) &&
    ["exact", "ambiguous"].includes(namesPathUnder(entry, worktreeRoots, inThisWorktree)) && !/\bturbo(?:\.exe)?\b.*\bdaemon\b/.test(entry.command) &&
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
  // Setup-file hooks are registered first: Vitest runs these before-hooks before the file's own,
  // and these after-hooks after the file's own.
  beforeEach(() => { before = { at: Date.now(), pids: listPids(), entries: new Set(tempLeftovers(folder)) }; });
  afterEach(async (context) => {
    // Tests that run concurrently share the snapshot, so what each started cannot be told apart.
    if (context?.task?.result?.state !== "fail" || context.task.concurrent || !before?.pids) return;
    const { at, pids, entries } = before;
    const find = () => { const listed = listProcesses(at); return listed && ownedProcesses(listed, scope()).filter((entry) => !pids.has(entry.pid)); };
    const started = find() ?? [];
    if (started.length > 0) await stopProcesses(started, find);
    for (const entry of tempLeftovers(folder)) if (!entries.has(entry)) removeTree(path.join(folder, entry));
  }, 60_000);
  afterAll(async (suite) => {
    let latest;
    const find = () => { latest = listProcesses(startedAt); return latest && ownedProcesses(latest, scope()); };
    const settled = await settle(find, FILE_GRACE_MS) ?? [];
    const stopped = new Map(settled.map((entry) => [entry.pid, entry]));
    const unstopped = settled.length > 0 ? await stopProcesses(settled, () => { const remaining = find(); for (const entry of remaining ?? []) stopped.set(entry.pid, entry); return remaining; }) : [];
    const owned = [...stopped.values()];
    const ambiguous = latest ? attributeProcesses(latest, scope()).ambiguous : [];
    const entries = tempLeftovers(folder).map((entry) => path.join(folder, entry));
    const removed = removeTree(folder);
    for (const directory of guardedDirectories()) {
      if (!existsSync(directory)) continue;
      entries.push(directory);
      removeTree(directory);
    }
    const notes = [];
    if (unstopped.length > 0) notes.push(`Still running after SIGKILL: ${unstopped.map((entry) => entry.pid).join(", ")}.`);
    if (!removed) entries.push(`${folder}, the test file's temp folder, which could not be removed`);
    if (owned.length > 0 || entries.length > 0 || ambiguous.length > 0) {
      // The absolute path, the same on every platform and from every working directory.
      throw new Error(report(suite?.filepath ?? "This test file", owned, entries, notes, { ambiguous }));
    }
  }, 60_000);
}
