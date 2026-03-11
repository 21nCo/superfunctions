import { describe } from "vitest";
import { MemoryAdapter } from "../../src/memory";
import { runConformanceSuite } from "./shared";

describe("MemoryAdapter conformance", () => {
  runConformanceSuite({
    name: "memory",
    create: () => new MemoryAdapter(),
    persistent: false,
  });
});
