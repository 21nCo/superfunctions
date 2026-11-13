import { buildWorkspaceCore } from '../test-support/workspace-core.js';

export function setup(): void {
  buildWorkspaceCore('@authfn/api-keys', new URL('./', import.meta.url));
}
