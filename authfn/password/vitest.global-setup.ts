import { buildWorkspaceCore } from '../test-support/workspace-core.js';

export function setup(): void {
  buildWorkspaceCore('@authfn/password', new URL('./', import.meta.url));
}
