import uri from "fast-uri";
import type { UriResolver } from "ajv/dist/types/index.js";

/** Preserve patched URI authority handling with JSON Schema-specific root/pointer rules. */
export const schemaUriResolver: UriResolver = {
  ...uri,
  resolve(base, reference) {
    // An anonymous schema has no public resource URI. Its literal relative dot
    // segments denote that root; do not restore URI equivalence for authored
    // paths, encoded dots, queries, root paths or authority-bearing references.
    if ((base === "" || base.startsWith("#")) && /^(?:\.{1,2}\/)*\.{1,2}\/?(?:#.*)?$/u.test(reference)) {
      const fragment = reference.indexOf("#");
      return fragment < 0 ? "" : reference.slice(fragment);
    }
    return uri.resolve(base, reference);
  },
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
