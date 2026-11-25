// Vite alias for consumers that build @uifn/core from source.
//
// The published package exposes `@uifn/core/primitives/overlay` from its own
// module and every other `@uifn/core/primitives/<id>` as an entry that
// re-exports from the primitives index (see package.json exports and
// scripts/build.mjs). Mirror that mapping for source builds, because most
// catalog primitives have no source file of their own.
import path from 'node:path';

const OWN_ENTRY_PRIMITIVES = new Set(['overlay']);

export function uifnCorePrimitiveAlias(uifnCoreSrc) {
  const primitives = path.join(uifnCoreSrc, 'primitives');
  return {
    find: /^@uifn\/core\/primitives\/([^/]+)$/,
    replacement: '$1',
    customResolver(id) {
      return path.join(primitives, OWN_ENTRY_PRIMITIVES.has(id) ? `${id}.ts` : 'index.ts');
    },
  };
}
