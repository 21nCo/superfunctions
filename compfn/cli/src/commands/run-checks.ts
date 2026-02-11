import { loadConfig } from "../config.js";
import { compFn } from "@superfunctions/compfn";

export async function runChecksCommand(options: { checkId?: string; config?: string }): Promise<void> {
  try {
    const config = await loadConfig(options.config);
    const api = compFn(config);

    let checksToRun: string[] = [];

    if (options.checkId) {
      checksToRun = [options.checkId];
    } else {
      const listResult = await api.checks.list();
      if (!listResult.ok) {
        console.error(`Error listing checks: ${listResult.error.message}`);
        process.exit(1);
      }
      checksToRun = listResult.result.map((check) => check.id);
    }

    if (checksToRun.length === 0) {
      console.log("No checks to run.");
      process.exit(0);
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
    process.exit(0);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
