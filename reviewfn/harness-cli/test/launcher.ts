import path from "node:path";
import { fileURLToPath } from "node:url";

/** The Node script that stands in for an agent CLI. */
export const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-cli.mjs");

const windows = process.platform === "win32";

/**
 * The trusted executable the fixture CLI runs through. On POSIX it is /usr/bin/env, an installed executable, since the
 * test's own Node may live in a world-writable tool cache or a Git checkout, which the adapter refuses as an executable;
 * on Windows, which has no /usr/bin/env and no POSIX world-writable bit, it is Node itself.
 */
export const AGENT = windows ? process.execPath : "/usr/bin/env";

/** The leading arguments that make AGENT run the fixture: Node and the script through env, or only the script. */
export const LAUNCH: readonly string[] = windows ? [FIXTURE] : [process.execPath, FIXTURE];
