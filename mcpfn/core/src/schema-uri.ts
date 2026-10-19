import uri from "fast-uri";
import type { UriResolver } from "ajv/dist/types/index.js";

/** Keep URI authority normalization in fast-uri and adapt only JSON Pointer fragments. */
export const schemaUriResolver: UriResolver = {
  ...uri,
  parse(value) {
    const parsed = uri.parse(value);
    if (parsed.fragment !== undefined) {
      // JSON Schema pointers decode the URI fragment before splitting on '/'.
      // Ajv splits first and then decodes each token. Re-encode the tokens so
      // percent signs are decoded exactly once, while encoded separators work.
      const fragment = decodeURIComponent(parsed.fragment);
      if (fragment.startsWith("/")) {
        parsed.fragment = fragment.split("/").map(encodeURIComponent).join("/");
      }
    }
    return parsed;
  },
};
