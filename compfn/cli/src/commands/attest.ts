import { withConfig } from "../config.js";
import { compFn } from "compfn";

export async function attestCommand(options: {
  controlId: string;
  actorId: string;
  outcome?: "pass" | "fail";
  config?: string;
}): Promise<void> {
  return withConfig(options.config, async (config) => {
    const api = compFn(config);

    const outcome = options.outcome ?? "pass";

    const evidenceResult = await api.evidence.create({
      controlId: options.controlId,
      type: "manual_attestation",
      actorId: options.actorId,
      outcome,
    });

    if (!evidenceResult.ok) {
      console.error(`Error creating attestation: ${evidenceResult.error.message}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Attestation created: ${evidenceResult.result.id}`);
    return;
  });
}
