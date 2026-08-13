export const REQUIRED_MODULE_IDS = [
  'authfn',
  'billfn',
  'browsefn',
  'cifn',
  'cmsfn',
  'compfn',
  'datafn',
  'filefn',
  'flowfn',
  'mailfn',
  'memoryfn',
  'plugfn',
  'recfn',
  'searchfn',
  'secfn',
  'sendfn',
  'testfn',
  'watchfn',
] as const;

export const OPTIONAL_MODULE_IDS = [
  'cachefn',
  'probefn',
] as const;

export const UNAVAILABLE_MODULE_IDS = [
  'apifn',
  'botfn',
  'docsfn',
  'hostfn',
  'langfn',
  'userfn',
] as const;

export const NESTED_MODULE_IDS = ['catchfn', 'logfn'] as const;
export const FOLDED_MODULE_IDS = ['contentfn'] as const;

export const KNOWN_MODULE_IDS = [
  'apifn',
  'authfn',
  'billfn',
  'botfn',
  'browsefn',
  'cachefn',
  'catchfn',
  'cifn',
  'cmsfn',
  'compfn',
  'contentfn',
  'datafn',
  'docsfn',
  'filefn',
  'flowfn',
  'hostfn',
  'langfn',
  'logfn',
  'mailfn',
  'memoryfn',
  'plugfn',
  'probefn',
  'recfn',
  'searchfn',
  'secfn',
  'sendfn',
  'testfn',
  'userfn',
  'watchfn',
] as const;

export type KnownModuleId = (typeof KNOWN_MODULE_IDS)[number];
export type ModuleAvailability = 'required-product' | 'optional-product' | 'nested' | 'folded' | 'unavailable';

export interface ModuleCatalogEntry {
  id: KnownModuleId;
  displayName: string;
  availability: ModuleAvailability;
  owner?: KnownModuleId;
}

const REQUIRED_SET = new Set<string>(REQUIRED_MODULE_IDS);
const OPTIONAL_SET = new Set<string>(OPTIONAL_MODULE_IDS);
const UNAVAILABLE_SET = new Set<string>(UNAVAILABLE_MODULE_IDS);
const FOLDED_SET = new Set<string>(FOLDED_MODULE_IDS);

const DISPLAY_NAMES: Record<KnownModuleId, string> = {
  apifn: 'ApiFn',
  authfn: 'AuthFn',
  billfn: 'BillFn',
  botfn: 'BotFn',
  browsefn: 'BrowseFn',
  cachefn: 'CacheFn',
  catchfn: 'CatchFn',
  cifn: 'CiFn',
  cmsfn: 'CmsFn',
  compfn: 'CompFn',
  contentfn: 'ContentFn',
  datafn: 'DataFn',
  docsfn: 'DocsFn',
  filefn: 'FileFn',
  flowfn: 'FlowFn',
  hostfn: 'HostFn',
  langfn: 'LangFn',
  logfn: 'LogFn',
  mailfn: 'MailFn',
  memoryfn: 'MemoryFn',
  plugfn: 'PlugFn',
  probefn: 'ProbeFn',
  recfn: 'RecFn',
  searchfn: 'SearchFn',
  secfn: 'SecFn',
  sendfn: 'SendFn',
  testfn: 'TestFn',
  userfn: 'UserFn',
  watchfn: 'WatchFn',
};

export const NESTED_OWNERS = {
  catchfn: 'watchfn',
  contentfn: 'cmsfn',
  logfn: 'watchfn',
} as const satisfies Record<(typeof NESTED_MODULE_IDS)[number] | (typeof FOLDED_MODULE_IDS)[number], KnownModuleId>;

export const MODULE_CATALOG: readonly ModuleCatalogEntry[] = KNOWN_MODULE_IDS.map((id) => {
  const owner = NESTED_OWNERS[id as keyof typeof NESTED_OWNERS];
  return {
    id,
    displayName: DISPLAY_NAMES[id],
    availability: UNAVAILABLE_SET.has(id)
      ? 'unavailable'
      : FOLDED_SET.has(id)
        ? 'folded'
      : owner
      ? 'nested'
      : OPTIONAL_SET.has(id)
        ? 'optional-product'
        : 'required-product',
    ...(owner ? { owner } : {}),
  };
});

const KNOWN_SET = new Set<string>(KNOWN_MODULE_IDS);

export class ModuleSelectionError extends Error {
  readonly code = 'SUPERCONSOLE_INVALID_MODULE_SELECTION';

  constructor(message: string, readonly details: Record<string, unknown>) {
    super(message);
    this.name = 'ModuleSelectionError';
  }
}

export function isKnownModuleId(value: string): value is KnownModuleId {
  return KNOWN_SET.has(value);
}

export function parseModuleSelection(
  value: string | readonly string[] | undefined,
  availableModuleIds: readonly string[] = KNOWN_MODULE_IDS,
): string[] {
  if (value === undefined) {
    throw new ModuleSelectionError('Super Console requires an explicit module selection; use [] for a shell-only installation.', {
      received: 'undefined',
    });
  }

  const candidates = (typeof value === 'string' ? value.split(',') : value)
    .map((candidate) => candidate.trim().toLowerCase())
    .filter(Boolean);
  const available = new Set(availableModuleIds);
  const unknown = [...new Set(candidates.filter((candidate) => !available.has(candidate)))];
  if (unknown.length > 0) {
    throw new ModuleSelectionError('The module selection contains unknown Superfunctions.', {
      unknown,
      available: [...available].sort(),
    });
  }

  const unavailable = candidates.filter((candidate) => UNAVAILABLE_SET.has(candidate));
  if (unavailable.length > 0) {
    throw new ModuleSelectionError('The module selection contains Superfunctions without a domain-backed administration service.', {
      unavailable: [...new Set(unavailable)],
    });
  }
  const folded = candidates.filter((candidate) => FOLDED_SET.has(candidate));
  if (folded.length > 0) {
    throw new ModuleSelectionError('Folded modules are provided by their owner and cannot be selected independently.', {
      folded: [...new Set(folded)],
      owners: folded.map((moduleId) => ({ moduleId, ownerId: NESTED_OWNERS[moduleId as keyof typeof NESTED_OWNERS] })),
    });
  }

  const selected = [...new Set(candidates)];
  const selectedSet = new Set(selected);
  const missingOwners = selected
    .filter((id): id is keyof typeof NESTED_OWNERS => id in NESTED_OWNERS)
    .map((id) => ({ moduleId: id, ownerId: NESTED_OWNERS[id] }))
    .filter(({ ownerId }) => !selectedSet.has(ownerId));
  if (missingOwners.length > 0) {
    throw new ModuleSelectionError('Nested modules require their owning module to be selected.', {
      missingOwners,
    });
  }

  return selected.sort((left, right) => {
    const leftIndex = KNOWN_MODULE_IDS.indexOf(left as KnownModuleId);
    const rightIndex = KNOWN_MODULE_IDS.indexOf(right as KnownModuleId);
    if (leftIndex < 0 && rightIndex < 0) return left.localeCompare(right);
    if (leftIndex < 0) return 1;
    if (rightIndex < 0) return -1;
    return leftIndex - rightIndex;
  });
}

export function catalogForSelection(selected: readonly KnownModuleId[]): ModuleCatalogEntry[] {
  const selectedSet = new Set(selected);
  return MODULE_CATALOG.filter(({ id }) => selectedSet.has(id));
}

export function isRequiredProductModule(id: KnownModuleId): boolean {
  return REQUIRED_SET.has(id);
}
