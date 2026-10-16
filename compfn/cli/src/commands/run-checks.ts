import { withConfig } from "../config.js";
import { compFn } from "compfn";

export async function runChecksCommand(options: { checkId?: string; config?: string }): Promise<void> {
  return withConfig(options.config, async (config) => {
    const api = compFn(config);

    let checksToRun: string[] = [];

    if (options.checkId) {
      checksToRun = [options.checkId];
    } else {
      const listResult = await api.checks.list();
      if (!listResult.ok) {
        console.error(`Error listing checks: ${listResult.error.message}`);
        process.exitCode = 1;
      return;
      }
      checksToRun = listResult.result.map((check) => check.id);
    }

    if (checksToRun.length === 0) {
      console.log("No checks to run.");
      return;
    }

    let passCount = 0;
    let failCount = 0;
    let unknownCount = 0;

    for (const checkId of checksToRun) {
      const runResult = await api.checks.run(checkId);
      if (!runResult.ok) {
        console.error(`Error running check ${checkId}: ${runResult.error.message}`);
        failCount++;
        continue;
      }

      const outcome = runResult.result.outcome;
      if (outcome === "pass") {
        passCount++;
      } else if (outcome === "fail") {
        failCount++;
      } else {
        unknownCount++;
      }
    }

    const total = checksToRun.length;
    console.log(`Ran ${total} check${total !== 1 ? "s" : ""}: ${passCount} pass, ${failCount} fail${unknownCount > 0 ? `, ${unknownCount} unknown` : ""}`);
    if (failCount > 0) process.exitCode = 1;
  });
}
