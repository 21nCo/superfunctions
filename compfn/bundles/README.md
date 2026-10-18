# CompFn Framework Bundles

Framework bundles provide pre-defined compliance frameworks with requirements and controls, allowing you to get started quickly without building mappings from scratch.

## Available Bundles

### SOC 2 Type II (2022)

**File**: `soc2-type2.json`

A comprehensive SOC 2 Type II framework bundle based on Trust Services Criteria for Security, Availability, Processing Integrity, Confidentiality, and Privacy.

**Includes**:
- 17 framework requirements covering:
  - CC6.x: Access controls, credential management
  - CC7.x: Security event detection and incident response
  - CC8.1: Change management
  - A1.x: Availability and capacity management
  - C1.x: Confidentiality and data disposal
- 43 pre-defined controls mapped to requirements

## Loading a Bundle

### Option 1: Using the `loadBundle` Helper (Recommended)

```typescript
import { compFn, loadBundle } from "compfn";
import soc2Bundle from "compfn/bundles/soc2-type2.json";

// Initialize compfn
const api = compFn({ database: adapter });

// Load the bundle (creates controls and framework)
const result = await loadBundle(api, soc2Bundle, {
  useStableControlIds: true // Legacy option; bundle references are always mapped
});

if (result.ok) {
  console.log(`Framework created: ${result.result.framework.name} (${result.result.framework.id})`);
  console.log(`Controls created: ${result.result.controls.length}`);
}
```

### Option 2: Manual Creation

You can also manually create controls and then the framework:

```typescript
import { compFn } from "compfn";
import soc2Bundle from "compfn/bundles/soc2-type2.json";

const api = compFn({ database: adapter });

// Step 1: Create controls (if bundle includes them)
const controlIdMap = new Map();
for (const control of soc2Bundle.controls) {
  const result = await api.controls.create(control);
  if (result.ok) {
    // Map bundle control ID to created control ID
    const stableId = control.id ?? control.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    controlIdMap.set(stableId, result.result.id);
  }
}

// Step 2: Update framework requirements with created control IDs
const frameworkInput = {
  ...soc2Bundle.framework,
  requirements: soc2Bundle.framework.requirements.map(req => ({
    ...req,
    controlIds: req.controlIds.map(cid => controlIdMap.get(cid) || cid)
  }))
};

// Step 3: Create the framework
const fwResult = await api.frameworks.create(frameworkInput);
if (fwResult.ok) {
  console.log(`Framework created: ${fwResult.result.id}`);
}
```

### Option 3: Framework Only (Use Existing Controls)

If you already have controls in your system, you can load just the framework and map to your existing control IDs:

```typescript
import { compFn } from "compfn";
import soc2Bundle from "compfn/bundles/soc2-type2.json";

const api = compFn({ database: adapter });

// Modify the framework to reference your existing control IDs
const customFramework = {
  ...soc2Bundle.framework,
  requirements: [
    {
      requirementId: "CC6.1",
      name: "Logical and Physical Access Controls",
      controlIds: ["my-rbac-control-id", "my-mfa-control-id"]
    },
    // ... other requirements
  ]
};

const result = await api.frameworks.create(customFramework);
```

## Bundle Structure

Each bundle is a JSON file with the following structure:

```typescript
interface FrameworkBundle {
  framework: {
    name: string;           // e.g., "SOC 2 Type II"
    version?: string;       // e.g., "2022"
    description?: string;   // Description of the framework
    requirements: Array<{
      requirementId: string;  // e.g., "CC6.1"
      name?: string;          // Human-readable requirement name
      controlIds: string[];   // Control IDs that satisfy this requirement
    }>;
  };
  controls?: Array<{        // Optional pre-defined controls
    id?: string; // Bundle-local reference, not the database ID
    name: string;
    description: string;
    category: string;
    tags?: string[];
  }>;
}
```

## Control ID Mapping

When using bundles with controls, requirement `controlIds` reference each control's explicit bundle-local `id`. Legacy controls without `id` use a slug derived from their name:

- "RBAC Enabled" → `rbac-enabled`
- "MFA Enforced" → `mfa-enforced`
- "Quarterly Access Reviews" → `quarterly-access-reviews`

`loadBundle` always remaps these references to service-generated IDs. The legacy `useStableControlIds` option is accepted but no longer needed. Each call creates new controls and a framework; repeated calls do not upsert or deduplicate.

## Customizing Bundles

You can create your own framework bundles by following the structure above. Save them as JSON files and load them using the same methods.

For custom bundles:
1. Define your framework metadata (name, version, description)
2. List requirements with their IDs and control mappings
3. Optionally include control definitions
4. Save as JSON and load using `loadBundle()` or manual creation

## Next Steps

After loading a bundle:
1. **Add Evidence**: Attach evidence to controls using `api.evidence.create()`
2. **Set Up Checks**: Create automated checks using `api.checks.create()` and adapters
3. **Monitor Readiness**: Check compliance status with `api.readiness.forFramework(frameworkId)`
4. **Export for Auditors**: Generate audit packs with `api.export.auditorPack({ frameworkId })`

## References

- [SOC 2 Trust Services Criteria](https://www.aicpa.org/interestareas/frc/assuranceadvisoryservices/aicpasoc2report.html)
- CompFn Documentation
- CompFn API Reference
