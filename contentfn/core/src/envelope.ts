/**
 * ContentFn envelope utilities.
 */

import type { ContentfnEnvelope, ContentfnError } from "./errors.js";

/**
 * Unwraps a ContentfnEnvelope: returns result for ok:true, throws error for ok:false.
 */
export function unwrapEnvelope<T>(env: ContentfnEnvelope<T>): T {
  if (env.ok) return env.result;
  throw env.error as ContentfnError;
}
