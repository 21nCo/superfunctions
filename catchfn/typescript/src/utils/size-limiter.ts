import { estimateSize, safeSerialize } from "./serialization.js";

/** Retain the newest context; reject reports that cannot fit without losing their content. */
export function limitPayloadSize(payload: any, maxSize: number): any {
  if (!Number.isInteger(maxSize) || maxSize <= 0) throw new RangeError("maxPayloadSize must be a positive integer");
  const limited = safeSerialize(payload);
  for (const field of ["consoleLogs", "networkRequests", "breadcrumbs"]) {
    while (estimateSize(limited) > maxSize && Array.isArray(limited[field]) && limited[field].length) {
      limited[field].shift();
    }
  }
  if (estimateSize(limited) > maxSize) throw new RangeError("Bug report exceeds maxPayloadSize; upload large attachments before capture");
  return limited;
}
