import { buildWorkspaceCore } from '../test-support/workspace-core.js';

export function setup(): void {
  buildWorkspaceCore('@authfn/email-otp', new URL('./', import.meta.url));
}
