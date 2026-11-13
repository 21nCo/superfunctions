import Ajv2020 from "ajv/dist/2020.js";
import { expect } from "vitest";
import { evidenceEventSchema, validateEvidenceEvent } from "../src/events.js";

// An independent JSON Schema validator, so the exported schema itself is
// checked and not only the hand-written validator that mirrors it.
const ajv = new Ajv2020({ strict: true, allErrors: true });
export const validateWithSchema = ajv.compile(evidenceEventSchema);

/** Assert that every event is a valid v1 event under both validators. */
export function expectValidEvents(events: readonly unknown[]): void {
  for (const event of events) {
    // Events cross process and file boundaries as JSON; validate that form.
    const json = JSON.parse(JSON.stringify(event));
    expect(validateWithSchema(json), JSON.stringify(validateWithSchema.errors)).toBe(true);
    expect(validateEvidenceEvent(json)).toEqual([]);
    expect(validateEvidenceEvent(event)).toEqual([]);
  }
}
