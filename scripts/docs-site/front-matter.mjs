// YAML-only front matter policy shared by the bundled runtime and the LLM prebuild.
// Keep this module free of Node built-ins: the runtime also runs on edge targets.

/** Labels that gray-matter 4 dispatches to its YAML engine (its alias lookup lowercases them). */
const YAML_LABELS = new Set(["yaml", "yml"]);
const MAX_REPORTED_LABEL = 64;

export class UnsupportedFrontMatterError extends Error {
  /**
   * @param {string} label
   * @param {string} sourcePath
   */
  constructor(label, sourcePath) {
    const shown = label.length > MAX_REPORTED_LABEL ? `${label.slice(0, MAX_REPORTED_LABEL)}…` : label;
    super(`Unsupported front matter engine ${JSON.stringify(shown)} in ${sourcePath}; only YAML front matter is allowed`);
    this.name = "UnsupportedFrontMatterError";
    this.code = "DOCS_FRONTMATTER_UNSUPPORTED";
    this.label = label;
    this.sourcePath = sourcePath;
  }
}

/**
 * The front matter opener after gray-matter 4's BOM stripping and `----` rejection, split at the
 * first line break (`newline` is -1 when the opener line runs to the end of the source).
 * @param {string} source
 */
function openerLine(source) {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  if (!text.startsWith("---") || text.charAt(3) === "-") return undefined;
  const rest = text.slice(3);
  return { rest, newline: rest.search(/\r?\n/) };
}

/**
 * Return the engine label gray-matter 4 (default options) would dispatch for `source`:
 * `undefined` when there is no front matter block, `""` for the bare default delimiter.
 * This mirrors its first-line label slicing exactly, including the dropped last character
 * when the opener line has no line break, so the label checked here is the label the parser would use.
 * @param {string} source
 * @returns {string | undefined}
 */
export function frontMatterLanguage(source) {
  const opener = openerLine(source);
  return opener && opener.rest.slice(0, opener.newline).trim();
}

/**
 * Reject every front matter engine declaration except the default delimiter and explicit YAML,
 * before any parser sees the source. Both the declared label (the whole opener line) and the label
 * gray-matter dispatches (which loses its last character without a line break) must be YAML or empty.
 * Plain Markdown passes through unchanged.
 * @param {string} source
 * @param {string} sourcePath
 */
export function assertYamlFrontMatter(source, sourcePath) {
  const opener = openerLine(source);
  if (!opener) return;
  const declared = (opener.newline === -1 ? opener.rest : opener.rest.slice(0, opener.newline)).trim();
  const dispatched = opener.rest.slice(0, opener.newline).trim();
  const label = [declared, dispatched].find((value) => value && !YAML_LABELS.has(value.toLowerCase()));
  if (label !== undefined) throw new UnsupportedFrontMatterError(label, sourcePath);
}
