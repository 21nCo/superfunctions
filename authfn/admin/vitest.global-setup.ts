import { buildWorkspaceCore } from '../core/test-support/workspace-core.js';

export function setup(): void {
  buildWorkspaceCore('@authfn/admin', new URL('./', import.meta.url));
}
