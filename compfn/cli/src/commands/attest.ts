import { loadConfig } from "../config.js";
import { compFn } from "compfn";

export async function attestCommand(options: {
  controlId: string;
  actorId: string;
  outcome?: "pass" | "fail";
  config?: string;
}): Promise<void> {
  try {
    const config = await loadConfig(options.config);
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
      process.exit(1);
    }

    console.log(`Attestation created: ${evidenceResult.result.id}`);
    process.exit(0);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
