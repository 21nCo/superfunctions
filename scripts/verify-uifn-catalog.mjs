#!/usr/bin/env node

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATALOG_SOURCE } from '../uifn/catalog/src/catalog-source.mjs';
import { CatalogError, compareGeneratedOutputs, createGeneratedOutputs, parseSwiftUISurfaceDeclarations, readSwiftUISurfaceDeclarations, verifyGeneratedDirectory, verifySwiftUISurfaceDeclarations, writeGeneratedOutputs } from '../uifn/catalog/src/compiler.mjs';
import { migrateCatalogDocument } from '../uifn/catalog/src/migrations.mjs';
import { SWIFTUI_STATUS_SOURCE } from '../uifn/catalog/src/swiftui-status.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedDirectory = path.join(repoRoot, 'uifn/catalog/generated');
const schemaFiles = ['primitive.schema.json', 'catalog.schema.json', 'generation-manifest.schema.json', 'migration.schema.json', 'swiftui-status.schema.json'];
const fixtureDirectory = path.join(repoRoot, 'uifn/catalog/fixtures/negative');
const swiftuiStatusFixtures = ['missing-swiftui-status.json', 'unknown-swiftui-status.json', 'unmapped-swiftui-surface.json'];
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'uifn-catalog-verify-'));

function expectCode(action, expectedCode) {
  try {
    action();
  } catch (error) {
    if (error.code === expectedCode) return expectedCode;
    throw error;
  }
  throw new CatalogError('UIFN_CATALOG_NEGATIVE_VECTOR_FAILED', `Expected ${expectedCode}.`);
}

try {
  for (const file of schemaFiles) JSON.parse(await readFile(path.join(repoRoot, 'uifn/catalog/schema', file), 'utf8'));
  const migrationRegistry = JSON.parse(await readFile(path.join(repoRoot, 'uifn/catalog/migrations/index.json'), 'utf8'));
  if (migrationRegistry.currentSchemaVersion !== 1 || migrationRegistry.migrations.length !== 1 || migrationRegistry.migrations[0].lossless !== true) {
    throw new CatalogError('UIFN_CATALOG_MIGRATION_REGISTRY_INVALID', 'Catalog migration registry must declare the lossless v0-to-v1 path.');
  }

  const first = createGeneratedOutputs();
  const second = createGeneratedOutputs();
  compareGeneratedOutputs(first.outputs, second.outputs);
  const firstDirectory = path.join(temporaryRoot, 'first');
  const secondDirectory = path.join(temporaryRoot, 'second');
  await writeGeneratedOutputs(firstDirectory, first.outputs);
  await writeGeneratedOutputs(secondDirectory, second.outputs);
  await verifyGeneratedDirectory(firstDirectory, second.outputs);
  await verifyGeneratedDirectory(secondDirectory, first.outputs);
  await verifyGeneratedDirectory(generatedDirectory, first.outputs);

  const missingAccessibility = structuredClone(CATALOG_SOURCE);
  delete missingAccessibility.primitives.find((primitive) => primitive.name === 'Tooltip').accessibility.rules;
  const missingCode = expectCode(() => createGeneratedOutputs(missingAccessibility), 'UIFN_CATALOG_FIELD_MISSING');

  const undocumentedDirectory = path.join(temporaryRoot, 'undocumented');
  const undocumentedOutputs = structuredClone(first.outputs);
  const undocumented = JSON.parse(undocumentedOutputs['core-exports.json']);
  undocumented.exports.push({ primitiveId: 'unregistered-primitive', primitiveName: 'UnregisteredPrimitive', symbol: 'createUnregisteredPrimitiveController', kind: 'interactive-controller', implementationStatus: 'implemented' });
  undocumentedOutputs['core-exports.json'] = `${JSON.stringify(undocumented, null, 2)}\n`;
  await writeGeneratedOutputs(undocumentedDirectory, undocumentedOutputs);
  let exportCode;
  try {
    await verifyGeneratedDirectory(undocumentedDirectory, first.outputs);
    throw new CatalogError('UIFN_CATALOG_NEGATIVE_VECTOR_FAILED', 'Expected UIFN_CATALOG_EXPORT_DRIFT.');
  } catch (error) {
    if (error.code !== 'UIFN_CATALOG_EXPORT_DRIFT') throw error;
    exportCode = error.code;
  }

  const swiftuiDeclarations = await readSwiftUISurfaceDeclarations(repoRoot);
  verifySwiftUISurfaceDeclarations(swiftuiDeclarations);
  const swiftuiStatus = JSON.parse(first.outputs['swiftui-status.json']);
  const swiftuiNegativeCodes = [];
  const swiftuiFixtures = await Promise.all(swiftuiStatusFixtures.map(async (file) => JSON.parse(await readFile(path.join(fixtureDirectory, file), 'utf8'))));
  for (const { mutation, expectedErrorCodes } of swiftuiFixtures) {
    const mutated = structuredClone(SWIFTUI_STATUS_SOURCE);
    const entry = mutated.primitives[mutation.swiftuiPrimitive];
    if (mutation.deleteField) delete entry[mutation.deleteField];
    else entry[mutation.setField] = mutation.value;
    swiftuiNegativeCodes.push(expectCode(() => createGeneratedOutputs(CATALOG_SOURCE, mutated), expectedErrorCodes[0]));
  }
  const unlisted = JSON.parse(await readFile(path.join(fixtureDirectory, 'unlisted-swiftui-surface.json'), 'utf8'));
  swiftuiNegativeCodes.push(expectCode(() => verifySwiftUISurfaceDeclarations([
    ...swiftuiDeclarations,
    ...parseSwiftUISurfaceDeclarations([{ path: unlisted.mutation.swiftSource, text: unlisted.mutation.text }]),
  ]), unlisted.expectedErrorCodes[0]));

  const migrated = migrateCatalogDocument({ schemaVersion: 0, components: [{ id: 'example' }] });
  if (!migrated.ok || migrated.document.schemaVersion !== 1 || !Array.isArray(migrated.document.primitives) || migrated.document.components) {
    throw new CatalogError('UIFN_CATALOG_MIGRATION_FAILED', 'The v0-to-v1 migration was not lossless.');
  }

  console.log(JSON.stringify({
    ok: true,
    command: 'verify:uifn-catalog',
    requirement: 'CAT-001',
    vectors: [
      { id: 'TV-CAT-001-P', ok: true, evidence: [`exact-${first.catalog.primitiveCount}-canonical-primitives`, 'two-byte-identical-generation-runs', 'checked-in-clean-diff', 'complete-requirement-dom-framework-mappings'] },
      { id: 'TV-CAT-001-N', ok: true, evidence: [missingCode, exportCode] },
    ],
    schemaVersion: first.catalog.schemaVersion,
    catalogVersion: first.catalog.catalogVersion,
    generatorVersion: first.catalog.generatorVersion,
    primitiveCount: first.catalog.primitiveCount,
    controllerCount: first.catalog.primitives.filter((primitive) => primitive.implementationKind === 'interactive-controller').length,
    typedStaticContractCount: first.catalog.primitives.filter((primitive) => primitive.implementationKind === 'typed-static-contract').length,
    frameworkCount: first.catalog.frameworks.length,
    sourceSha256: first.catalog.sourceSha256,
    catalogSha256: first.catalog.catalogSha256,
    generatedOutputCount: Object.keys(first.outputs).length,
    manifestOutputCount: first.manifest.outputCount,
    generationRuns: 2,
    byteIdentical: true,
    cleanDiff: true,
    schemaFiles,
    migrationsApplied: migrated.applied,
    swiftui: {
      statusCounts: swiftuiStatus.statusCounts,
      primitivesWithStatus: swiftuiStatus.primitives.length,
      surfaceCount: swiftuiStatus.surfaces.length,
      nonSurfaceCount: SWIFTUI_STATUS_SOURCE.nonSurfaces.length,
      unmappedSurfaces: swiftuiStatus.surfaces.filter((surface) => surface.primitives.length === 0).map((surface) => surface.id),
      declaredSurfacesMatchSources: true,
      negativeVectors: swiftuiNegativeCodes,
    },
    implementationEvidence: true,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, command: 'verify:uifn-catalog', code: error.code ?? 'UIFN_CATALOG_VERIFICATION_FAILED', message: error.message, details: error.details ?? {} }, null, 2));
  process.exitCode = 1;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
