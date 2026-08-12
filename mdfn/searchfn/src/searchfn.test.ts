import { describe, expect, it } from "vitest";
import { parseMarkdown } from "@mdfn/markdown";
import { createSearchRecords } from "./index";
describe("search records", () => { it("uses canonical extraction", () => expect(createSearchRecords("d", parseMarkdown("# H\n\nBody").document)[0]?.text).toContain("Body")); });
