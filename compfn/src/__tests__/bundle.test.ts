/**
 * Tests for framework bundle loading (BUNDLE-001 / PHASE_08).
 * Verifies that framework bundles can be loaded and created successfully.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { compFn } from "../compfn.js";
import { loadBundle } from "../bundles/loader.js";
import type { FrameworkBundle } from "../bundles/loader.js";
import { createSchemaIfSupported } from "../storage/adapter.js";

describe("Bundle loading (TV-BUNDLE-001)", () => {
  let api: ReturnType<typeof compFn>;

  beforeEach(async () => {
    const db = memoryAdapter();
    await db.initialize();
    const result = await createSchemaIfSupported(db, { namespace: "compfn" });
    if (!result.success) throw new Error(result.errors?.join("; "));
    api = compFn({ database: db, namespace: "compfn" });
  });

  it("TV-BUNDLE-001: Load framework bundle with controls and create framework successfully", async () => {
    // Arrange: Create a test bundle similar to SOC 2
    const testBundle: FrameworkBundle = {
      framework: {
        name: "SOC 2 Type II",
        version: "2022",
        description: "Test SOC 2 framework bundle",
        requirements: [
          {
            requirementId: "CC6.1",
            name: "Logical and Physical Access Controls",
            controlIds: ["rbac-enabled", "mfa-enforced"],
          },
          {
            requirementId: "CC6.2",
            name: "Prior to Issuing System Credentials",
            controlIds: ["user-provisioning-approved"],
          },
        ],
      },
      controls: [
        {
          name: "RBAC Enabled",
          description: "Role-Based Access Control is implemented and enforced.",
          category: "access-control",
          tags: ["soc2", "security"],
        },
        {
          name: "MFA Enforced",
          description: "Multi-Factor Authentication is required.",
          category: "access-control",
          tags: ["soc2", "security"],
        },
        {
          name: "User Provisioning Approved",
          description: "User account creation requires approval.",
          category: "access-control",
          tags: ["soc2"],
        },
      ],
    };

    // Act: Load the bundle
    const result = await loadBundle(api, testBundle, { useStableControlIds: true });

    // Assert: Bundle loaded successfully
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify framework was created
    expect(result.result.framework).toBeDefined();
    expect(result.result.framework.name).toBe("SOC 2 Type II");
    expect(result.result.framework.id).toBeDefined();

    // Verify controls were created
    expect(result.result.controls).toHaveLength(3);
    expect(result.result.controls[0].name).toBe("RBAC Enabled");
    expect(result.result.controls[1].name).toBe("MFA Enforced");
    expect(result.result.controls[2].name).toBe("User Provisioning Approved");

    // Verify framework has requirements with controlIds
    const fwResult = await api.frameworks.get(result.result.framework.id);
    expect(fwResult.ok).toBe(true);
    if (!fwResult.ok) return;

    expect(fwResult.result.requirements).toHaveLength(2);
    expect(fwResult.result.requirements[0].requirementId).toBe("CC6.1");
    expect(fwResult.result.requirements[0].controlIds).toHaveLength(2);
    expect(fwResult.result.requirements[1].requirementId).toBe("CC6.2");
    expect(fwResult.result.requirements[1].controlIds).toHaveLength(1);
  });

  it("should load bundle without controls (framework only)", async () => {
    // First create controls manually
    const c1 = await api.controls.create({
      name: "Test Control 1",
      description: "Test",
      category: "test",
    });
    const c2 = await api.controls.create({
      name: "Test Control 2",
      description: "Test",
      category: "test",
    });

    expect(c1.ok).toBe(true);
    expect(c2.ok).toBe(true);
    if (!c1.ok || !c2.ok) return;

    // Create bundle with framework only (no controls array)
    const frameworkOnlyBundle: FrameworkBundle = {
      framework: {
        name: "Test Framework",
        version: "1.0",
        requirements: [
          {
            requirementId: "REQ-001",
            controlIds: [c1.result.id, c2.result.id],
          },
        ],
      },
    };

    // Load the bundle
    const result = await loadBundle(api, frameworkOnlyBundle);

    // Assert
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.result.framework.name).toBe("Test Framework");
    expect(result.result.controls).toHaveLength(0); // No controls in bundle
  });

  it("should fail if bundle references non-existent control IDs", async () => {
    // Bundle with invalid control IDs
    const invalidBundle: FrameworkBundle = {
      framework: {
        name: "Invalid Framework",
        requirements: [
          {
            requirementId: "REQ-001",
            controlIds: ["nonexistent-control-id"],
          },
        ],
      },
    };

    // Try to load the bundle
    const result = await loadBundle(api, invalidBundle);

    // Should fail validation
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("should handle duplicate control creation gracefully when using stable IDs", async () => {
    // Create a control manually first
    const existingControl = await api.controls.create({
      name: "Existing Control",
      description: "Already exists",
      category: "test",
    });

    expect(existingControl.ok).toBe(true);
    if (!existingControl.ok) return;

    // Try to load bundle with same control (but via loadBundle)
    const bundle: FrameworkBundle = {
      framework: {
        name: "Test Framework",
        requirements: [
          {
            requirementId: "REQ-001",
            controlIds: ["existing-control"],
          },
        ],
      },
      controls: [
        {
          name: "Existing Control",
          description: "Already exists",
          category: "test",
        },
      ],
    };

    // Load with stable IDs - should skip creating duplicate
    const result = await loadBundle(api, bundle, { useStableControlIds: true });

    // Should succeed (skips duplicate creation)
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should only show 1 control in result (the existing one was reused)
    expect(result.result.controls).toHaveLength(1);
  });

  it("should create framework with multiple requirements", async () => {
    const bundle: FrameworkBundle = {
      framework: {
        name: "Comprehensive Framework",
        version: "2022",
        requirements: [
          { requirementId: "R1", controlIds: ["control-1", "control-2"] },
          { requirementId: "R2", controlIds: ["control-3"] },
          { requirementId: "R3", controlIds: ["control-1", "control-3"] },
        ],
      },
      controls: [
        { name: "Control 1", description: "C1", category: "cat1" },
        { name: "Control 2", description: "C2", category: "cat1" },
        { name: "Control 3", description: "C3", category: "cat2" },
      ],
    };

    const result = await loadBundle(api, bundle, { useStableControlIds: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Get the framework and verify requirements
    const fw = await api.frameworks.get(result.result.framework.id);
    expect(fw.ok).toBe(true);
    if (!fw.ok) return;

    expect(fw.result.requirements).toHaveLength(3);
    expect(fw.result.requirements[0].requirementId).toBe("R1");
    expect(fw.result.requirements[1].requirementId).toBe("R2");
    expect(fw.result.requirements[2].requirementId).toBe("R3");
  });
});
