#!/usr/bin/env node

import { isCheckInvocation } from "./commands/check-args.js";
import { runCli } from "./index.js";
import { withSignalAbort } from "./signals.js";

void (async () => {
  const argv = process.argv.slice(2);
  // Only `apifn check` writes files it must roll back; every other command keeps the default
  // signal actions (`apifn serve` stops on Ctrl-C).
  const code = isCheckInvocation(argv) ? await withSignalAbort((signal) => runCli(argv, { signal })) : await runCli(argv);
  if (code !== 0) {
    process.exitCode = code;
  }
})();
