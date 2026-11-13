import { buildWorkspaceCore } from '../core/test-support/workspace-core.js';

export function setup(): void {
  buildWorkspaceCore('@authfn/oauth-provider', new URL('./', import.meta.url));
}
