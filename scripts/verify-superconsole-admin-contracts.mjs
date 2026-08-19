import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = process.cwd();
const entries = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name.endsWith('fn'))
  .map((entry) => entry.name)
  .sort();

const packages = [];
for (const directory of entries) {
  const packagePath = path.join(root, directory, 'admin', 'package.json');
  try {
    const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
    packages.push({ directory, name: manifest.name });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

if (packages.length !== 29) {
  throw new Error(`Expected 29 function administration packages, found ${packages.length}.`);
}

const kernel = await import('@superfunctions/admin');
const client = new kernel.AdminClient({
  baseUrl: 'https://admin-contract.invalid/api/admin/v1',
  timeoutMs: false,
  fetch: async () => {
    throw new Error('Contract verification must not perform network I/O.');
  },
});

const expectedAvailability = new Map([
  ['required-product', 20],
  ['optional-product', 6],
  ['nested', 2],
  ['folded', 1],
]);
const availability = new Map();
const moduleIds = new Set();
const operationIds = new Set();
let resourceCount = 0;
let operationCount = 0;

for (const entry of packages) {
  const packageDirectory = path.join(root, entry.directory, 'admin');
  const moduleUrl = pathToFileURL(path.join(packageDirectory, 'dist', 'index.js')).href;
  const adminModule = await import(moduleUrl);
  const manifest = adminModule.adminCapability;
  if (!manifest) throw new Error(`${entry.name} does not export adminCapability.`);

  const issues = kernel.validateAdminCapabilityManifest(manifest);
  if (issues.length > 0) {
    throw new Error(`${entry.name} has an invalid manifest:\n${issues.map((issue) => `- ${issue.path}: ${issue.message}`).join('\n')}`);
  }
  if (moduleIds.has(manifest.id)) throw new Error(`Duplicate administration module id: ${manifest.id}.`);
  moduleIds.add(manifest.id);
  availability.set(manifest.availability, (availability.get(manifest.availability) ?? 0) + 1);

  const resources = manifest.resources ?? [];
  if (manifest.availability === 'folded') {
    if (manifest.id !== 'contentfn' || resources.length !== 0 || manifest.operations.length !== 0) {
      throw new Error('ContentFn must be the only empty folded capability and must remain owned by CmsFn.');
    }
  } else if (resources.length === 0 || manifest.operations.length === 0) {
    throw new Error(`${entry.name} is selectable but exposes no domain-backed resources or operations.`);
  }

  for (const resource of resources) {
    resourceCount += 1;
    if (!resource.idField || !resource.displayFields?.length) {
      throw new Error(`${entry.name} resource ${resource.id} lacks generic Console identity/display metadata.`);
    }
    if (!manifest.operations.some((operation) =>
      operation.target?.resource === resource.id ||
      operation.route?.path.split('/').includes(resource.id) ||
      operation.id.split('.').some((segment) => segment === resource.id || segment.endsWith(`-${resource.id}`))
    )) {
      throw new Error(`${entry.name} resource ${resource.id} has no matching operation route or target.`);
    }
  }
  for (const operation of manifest.operations) {
    operationCount += 1;
    if (operationIds.has(operation.id)) throw new Error(`Duplicate global operation id: ${operation.id}.`);
    operationIds.add(operation.id);
  }

  const clientFactories = Object.entries(adminModule).filter(
    ([name, value]) => /^create[A-Z][A-Za-z0-9]*AdminClient$/.test(name) && typeof value === 'function',
  );
  if (clientFactories.length !== 1) {
    throw new Error(`${entry.name} must export exactly one named function administration client factory.`);
  }
  const [factoryName, factory] = clientFactories[0];
  const capabilityClient = factory(client);
  for (const method of ['availability', 'invoke', 'pages', 'raw']) {
    if (typeof capabilityClient?.[method] !== 'function') {
      throw new Error(`${entry.name} ${factoryName} dropped common SDK method ${method}().`);
    }
  }
  if (capabilityClient.manifest !== manifest || typeof capabilityClient.operations !== 'object') {
    throw new Error(`${entry.name} ${factoryName} does not preserve the shared capability SDK contract.`);
  }
  if (Object.keys(capabilityClient.operations).length !== manifest.operations.length) {
    throw new Error(`${entry.name} ${factoryName} operation methods do not exactly cover its manifest.`);
  }
}

for (const [kind, expected] of expectedAvailability) {
  const actual = availability.get(kind) ?? 0;
  if (actual !== expected) throw new Error(`Expected ${expected} ${kind} capabilities, found ${actual}.`);
}
for (const kind of availability.keys()) {
  if (!expectedAvailability.has(kind)) throw new Error(`Unexpected availability category: ${kind}.`);
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  packages: packages.length,
  modules: moduleIds.size,
  resources: resourceCount,
  operations: operationCount,
  availability: Object.fromEntries([...availability].sort()),
  commonSdkMethods: ['availability', 'invoke', 'pages', 'raw'],
}, null, 2)}\n`);
