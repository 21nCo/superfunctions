# PHASE_08: Framework bundle

## Phase goal

Ship at least one framework definition as loadable data (e.g. SOC 2 Type II or ISO 27001). Bundle includes framework metadata and requirements with controlIds. Optionally include control definitions so user can create controls from bundle or use pre-created controls. Document how to load and apply the bundle (e.g. frameworks.create(bundle) or import script).

## In scope

- One or more JSON/TS data files defining Framework (and optionally Control[]) for SOC 2 or ISO 27001
- Documentation: bundle name, version, how to load (API or file path or import)
- Test: loading bundle and creating framework(s) via API succeeds (TV-BUNDLE-001)

## Out of scope

- Multiple framework bundles; exact requirement IDs and control names (implementation or product choice)

## Deliverables

- `bundles/soc2-type2.json` or `bundles/iso27001-2022.json` (or .ts) – framework with requirements array; optionally controls array
- README or docs: “Loading a framework bundle” – e.g. const bundle = require('./bundles/soc2-type2.json'); await compfn.frameworks.create(bundle.framework); for (const c of bundle.controls) await compfn.controls.create(c);
- Test: TV-BUNDLE-001 – load bundle, create framework (and controls if needed), assert framework has requirements

## Requirements covered

- BUNDLE-001

## Implementation tasks

1. Create bundle file: framework object with id (or omit for create to generate), name (e.g. "SOC 2 Type II"), version "2022", requirements array. Each requirement: requirementId (e.g. "CC6.1"), controlIds (array). ControlIds may reference controls that user creates separately, or bundle can include control definitions with stable ids so controlIds in requirements match.
2. If controlIds in bundle reference controls by id, document “Create these controls first” with list of control id/name/description, or include controls in bundle and create controls then framework with same ids.
3. Add test: load bundle; create controls from bundle (if any); create framework from bundle; assert frameworks.get(frameworkId) returns framework with requirements.length > 0.
4. Document in SPEC or README: “Framework bundles” section with at least one bundle and load instructions.

## Verification steps

- Run TV-BUNDLE-001; pass.
- Documentation lists bundle and load steps.

## Stop condition

- At least one framework bundle shipped and loadable; TV-BUNDLE-001 passes; docs updated.
