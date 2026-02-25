/**
 * System fields tests
 * Tests TV-SYS-001 from TEST_VECTORS.md
 */

import { describe, it, expect } from "vitest";
import { SYSTEM_FIELDS, READONLY_SYSTEM_FIELDS } from "../src/system-fields.js";

describe("SYSTEM_FIELDS", () => {
  it("TV-SYS-001: contains all 6 system fields", () => {
    expect(SYSTEM_FIELDS.has("id")).toBe(true);
    expect(SYSTEM_FIELDS.has("createdAt")).toBe(true);
    expect(SYSTEM_FIELDS.has("updatedAt")).toBe(true);
    expect(SYSTEM_FIELDS.has("createdBy")).toBe(true);
    expect(SYSTEM_FIELDS.has("updatedBy")).toBe(true);
    expect(SYSTEM_FIELDS.has("isArchived")).toBe(true);
    expect(SYSTEM_FIELDS.size).toBe(6);
  });

  it("TV-SYS-001: excludes non-system fields", () => {
    expect(SYSTEM_FIELDS.has("title")).toBe(false);
    expect(SYSTEM_FIELDS.has("name")).toBe(false);
    expect(SYSTEM_FIELDS.has("label")).toBe(false);
  });
});

describe("READONLY_SYSTEM_FIELDS", () => {
  it("TV-SYS-001: contains 4 readonly system fields", () => {
    expect(READONLY_SYSTEM_FIELDS.has("createdAt")).toBe(true);
    expect(READONLY_SYSTEM_FIELDS.has("updatedAt")).toBe(true);
    expect(READONLY_SYSTEM_FIELDS.has("createdBy")).toBe(true);
    expect(READONLY_SYSTEM_FIELDS.has("updatedBy")).toBe(true);
    expect(READONLY_SYSTEM_FIELDS.size).toBe(4);
  });

  it("TV-SYS-001: does not include id or isArchived", () => {
    expect(READONLY_SYSTEM_FIELDS.has("id")).toBe(false);
    expect(READONLY_SYSTEM_FIELDS.has("isArchived")).toBe(false);
  });

  it("is a subset of SYSTEM_FIELDS", () => {
    for (const field of READONLY_SYSTEM_FIELDS) {
      expect(SYSTEM_FIELDS.has(field)).toBe(true);
    }
  });
});
