import { describe, expect, it } from 'vitest';
import { describeAuthfnDependency } from '../../../test-support/workspace-core.js';

describeAuthfnDependency({ describe, it, expect }, new URL('../../', import.meta.url));
