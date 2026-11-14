import { describe, expect, it } from 'vitest';
import { describeAuthfnDependency } from '../../../core/test-support/workspace-core.js';

// This package re-exports the placement-context issuer, so the core it
// resolves decides which scopes the signed claim carries. An older nested
// core signs every stored API-key scope instead of the registry-grantable ones.
describeAuthfnDependency({ describe, it, expect }, new URL('../../', import.meta.url));
