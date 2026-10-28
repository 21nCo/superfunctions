// Identifier and literal rules for generated Python. Generated identifiers are ASCII, so two names
// never become one under Python's NFKC identifier normalization.

/** Python keywords (3.10 to 3.13); soft keywords such as `match` and `type` are ordinary names. */
export const PYTHON_KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

export const PY_TYPE_NAME = /^[A-Z][A-Za-z0-9_]*$/;
export const PY_MODULE_NAME = /^[a-z_][a-z0-9_]*$/;

function words(name: string): string[] {
  return name.match(/[A-Za-z0-9]+/g) ?? [];
}

/** `project-page` → `ProjectPage`; characters outside ASCII letters and digits separate words; a leading digit gets a `Model` prefix. */
export function pyPascalCase(name: string): string {
  const joined = words(name)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join("");
  return joined === "" || /^\d/.test(joined) ? `Model${joined}` : joined;
}

/**
 * `listTasks` → `list_tasks`, `X-Request-Id` → `x_request_id`, `HTTPServer` → `http_server`. Never starts with an
 * underscore, so it cannot shadow a module-private name; a keyword or `self` gets a trailing underscore.
 */
export function snakeCase(name: string): string {
  const parts = words(name).flatMap((word) =>
    word
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(" ")
  );
  let joined = parts.map((part) => part.toLowerCase()).join("_");
  if (joined === "") joined = "value";
  else if (/^\d/.test(joined)) joined = `p_${joined}`;
  return PYTHON_KEYWORDS.has(joined) || joined === "self" ? `${joined}_` : joined;
}

/** A double-quoted Python string literal holding only printable ASCII. */
export function pyString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === "\\") out += "\\\\";
    else if (char === '"') out += '\\"';
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (code >= 0x20 && code < 0x7f) out += char;
    else if (code <= 0xff) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code <= 0xffff) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += `\\U${code.toString(16).padStart(8, "0")}`;
  }
  return `${out}"`;
}

/** Free text as `#` comment lines: one line per text line, control characters replaced. */
export function pyComment(lines: Array<string | null | undefined>, indent = ""): string {
  const text = clean(lines);
  if (text === "") return "";
  return `${text
    .split("\n")
    .map((line) => `${indent}#${line === "" ? "" : ` ${line}`}`)
    .join("\n")}\n`;
}

/** Free text as a docstring: backslashes and quotes escaped, so it can neither end early nor form an escape. */
export function pyDocstring(lines: Array<string | null | undefined>, indent: string): string {
  const text = clean(lines).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  if (text === "") return "";
  const body = text.split("\n").map((line, index) => (index === 0 || line === "" ? line : `${indent}${line}`));
  return `${indent}"""${body.join("\n")}${body.length > 1 ? `\n${indent}` : ""}"""\n`;
}

function clean(lines: Array<string | null | undefined>): string {
  return lines
    .filter((line): line is string => typeof line === "string" && line.trim() !== "")
    .join("\n\n")
    .replace(/\r\n?/g, "\n")
    // In unicode mode the surrogate range matches only unpaired surrogates, which UTF-8 cannot encode.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\ud800-\udfff]/gu, " ")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}
