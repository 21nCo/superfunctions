import { describe, expect, it } from "vitest";
import { isMarkdownContent, markdownContent } from "./index";
describe("markdown content", () => { it("is explicit", () => expect(isMarkdownContent(markdownContent("# x"))).toBe(true)); });
