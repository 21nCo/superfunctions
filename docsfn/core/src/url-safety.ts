import { decodeHTML } from "entities";

// Mirrors WHATWG URL parsing: leading/trailing C0 controls and spaces are
// stripped and tabs/newlines removed before the scheme is read, so an entity
// such as `&#1;javascript:` still reaches the browser as a script URL.
export function isJavascriptUrl(value: string): boolean {
  const normalized = decodeHTML(value)
    .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "")
    .replace(/[\t\n\r]/g, "");
  return /^javascript:/i.test(normalized);
}
