import { describe, expect, it } from 'vitest';
import {
  KNOWN_MODULE_IDS,
  MODULE_CATALOG,
  ModuleSelectionError,
  NESTED_MODULE_IDS,
  OPTIONAL_MODULE_IDS,
  REQUIRED_MODULE_IDS,
  catalogForSelection,
  parseModuleSelection,
} from '../../src/lib/server/catalog';

describe('Super Console module catalog', () => {
  it('contains all 29 product and nested administration capabilities exactly once', () => {
    expect(KNOWN_MODULE_IDS).toHaveLength(29);
    expect(new Set(KNOWN_MODULE_IDS)).toHaveLength(29);
    expect(MODULE_CATALOG).toHaveLength(29);
    expect(REQUIRED_MODULE_IDS).toHaveLength(20);
    expect(OPTIONAL_MODULE_IDS).toHaveLength(6);
    expect(NESTED_MODULE_IDS).toHaveLength(3);
    expect(new Set([...REQUIRED_MODULE_IDS, ...OPTIONAL_MODULE_IDS, ...NESTED_MODULE_IDS])).toHaveLength(29);
  });

  it('parses an explicit, deterministic selection without auto-enabling modules', () => {
    expect(parseModuleSelection('watchfn,catchfn,logfn, authfn,watchfn')).toEqual([
      'authfn',
      'catchfn',
      'logfn',
      'watchfn',
    ]);
    expect(() => parseModuleSelection(undefined)).toThrow(/explicit module selection/);
    expect(parseModuleSelection([])).toEqual([]);
  });

  it('rejects unknown modules', () => {
    expect(() => parseModuleSelection('authfn,unknownfn')).toThrow(ModuleSelectionError);
  });

  it('rejects a nested module without its owner', () => {
    expect(() => parseModuleSelection('catchfn')).toThrow(
      'Nested modules require their owning module to be selected.'
    );
    expect(parseModuleSelection('watchfn,catchfn,logfn')).toEqual([
      'catchfn',
      'logfn',
      'watchfn',
    ]);
  });

  it('allows owners without unused nested products while folding selected children', () => {
    expect(parseModuleSelection('watchfn')).toEqual(['watchfn']);
    expect(parseModuleSelection('cmsfn')).toEqual(['cmsfn']);
    expect(parseModuleSelection('watchfn,catchfn')).toEqual(['catchfn', 'watchfn']);
    expect(parseModuleSelection('cmsfn,contentfn')).toEqual(['cmsfn', 'contentfn']);
  });

  it('returns only explicitly selected catalog entries', () => {
    expect(catalogForSelection(['authfn', 'cmsfn', 'contentfn']).map(({ id }) => id)).toEqual([
      'authfn',
      'cmsfn',
      'contentfn',
    ]);
  });
});
