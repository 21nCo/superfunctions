// Identifier rules for generated TypeScript.

function words(name: string): string[] {
  return name
    .split(/[^\p{L}\p{Nd}]+/u)
    .filter((word) => word !== "");
}

/** `project-page` → `ProjectPage`; letters outside ASCII are kept; a leading digit gets a `Model` prefix. */
export function pascalCase(name: string): string {
  const joined = words(name)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join("");
  return joined === "" || /^\p{Nd}/u.test(joined) ? `Model${joined}` : joined;
}

/** `Idempotency-Key` → `idempotencyKey`, `X-API-Key` → `xAPIKey`; keeps already camel-cased names. */
export function camelCase(name: string): string {
  const parts = words(name);
  const joined = parts.map((word, index) => (index === 0 ? word[0].toLowerCase() + word.slice(1) : word[0].toUpperCase() + word.slice(1))).join("");
  return joined === "" || /^\p{Nd}/u.test(joined) ? `p${joined}` : joined;
}

export const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
export const TYPE_NAME = /^[A-Z][A-Za-z0-9_]*$/;

/** A property key as written in a type literal. */
export function propertyKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/** Free text inside a block comment: no comment terminator, no control characters, one ` * ` per line. */
export function docComment(lines: Array<string | null | undefined>, indent = ""): string {
  const text = lines
    .filter((line): line is string => typeof line === "string" && line.trim() !== "")
    .join("\n\n")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g, " ")
    .replace(/\*\//g, "*\\/");
  if (text === "") return "";
  const body = text.split("\n").map((line) => `${indent} *${line === "" ? "" : ` ${line}`}`);
  return `${indent}/**\n${body.join("\n")}\n${indent} */\n`;
}

/** Records every generated name in one namespace and reports the first owner of a repeated one. */
export class NameRegistry {
  readonly #owners = new Map<string, string>();

  /** Returns the earlier owner when `name` is taken. */
  claim(name: string, owner: string): string | null {
    const previous = this.#owners.get(name);
    if (previous !== undefined) return previous;
    this.#owners.set(name, owner);
    return null;
  }
}
