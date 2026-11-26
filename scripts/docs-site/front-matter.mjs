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
 * Return the engine label gray-matter 4 (default options) would dispatch for `source`:
 * `undefined` when there is no front matter block, `""` for the bare default delimiter.
 * This mirrors its BOM stripping, `----` rejection and first-line label slicing exactly,
 * so the label checked here is the label the parser would use.
 * @param {string} source
 * @returns {string | undefined}
 */
export function frontMatterLanguage(source) {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  if (!text.startsWith("---") || text.charAt(3) === "-") return undefined;
  const rest = text.slice(3);
  return rest.slice(0, rest.search(/\r?\n/)).trim();
}

/**
 * Reject every front matter engine declaration except the default delimiter and explicit YAML,
 * before any parser sees the source. Plain Markdown passes through unchanged.
 * @param {string} source
 * @param {string} sourcePath
 */
export function assertYamlFrontMatter(source, sourcePath) {
  const label = frontMatterLanguage(source);
  if (!label || YAML_LABELS.has(label.toLowerCase())) return;
  throw new UnsupportedFrontMatterError(label, sourcePath);
}
