import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const testsDir = resolve(dirname(fileURLToPath(import.meta.url)), 'src/__tests__');
const ecosystemTest = 'src/__tests__/ecosystem-contract.test.ts';

// The ecosystem contract test is imported verbatim from `next` so the repo
// sync does not lose it. It imports the admin module of every function,
// including functions whose directories are owned by `next` and are not in
// this repository's public manifest (superfunctions.owners.json), such as
// browsefn, cachefn, cifn, cmsfn, compfn, contentfn, docsfn, flowfn, probefn,
// recfn, testfn and userfn. The Public boundary check keeps those directories
// out of this repository, so the suite never runs here or in this
// repository's CI: it is skipped with a warning naming the missing modules,
// and it runs only in a checkout where every imported module exists (`next`
// after the sync). src/__tests__ is outside tsconfig.json, so this package's
// typecheck does not check the suite's operation-ID assertions either.
const missingAdminModules = [
  ...readFileSync(resolve(testsDir, 'ecosystem-contract.test.ts'), 'utf8').matchAll(
    /from "(\.\.\/\.\.\/\.\.\/\.\.\/[^"]+\/admin\/src\/index)\.js"/g,
  ),
]
  .map(([, specifier]) => specifier)
  .filter((specifier) => !existsSync(resolve(testsDir, `${specifier}.ts`)))
  .map((specifier) => specifier.replace(/^(\.\.\/)+/, '').replace(/\/src\/index$/, ''));

if (missingAdminModules.length > 0) {
  console.warn(
    `[apifn/admin] skipping ${ecosystemTest}: it imports admin modules that are not in this repository (it runs only where every module exists, such as next): ${missingAdminModules.join(', ')}`,
  );
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...(missingAdminModules.length > 0 ? [ecosystemTest] : [])],
  }
});
