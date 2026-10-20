import type { ConsentPatch, ConsentState } from '../types';

/** Application consent plus a browser/forwarded DNT veto; no persistence or consent collection. */
export class ConsentPolicy {
  private analytics = true;
  private messaging = true;
  private forwardedDnt = false;
  constructor(patch: ConsentPatch = {}) { this.update(patch); }
  update(patch: ConsentPatch): void {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || ![Object.prototype, null].includes(Object.getPrototypeOf(patch))) throw new TypeError('Consent must be a plain object');
    const entries = Object.entries(Object.getOwnPropertyDescriptors(patch));
    for (const [key, descriptor] of entries) {
      if (!['analytics', 'messaging', 'doNotTrack'].includes(key) || !('value' in descriptor) || (descriptor.value !== undefined && typeof descriptor.value !== 'boolean')) throw new TypeError('Consent values must be booleans');
    }
    if (patch.analytics !== undefined) this.analytics = patch.analytics;
    if (patch.messaging !== undefined) this.messaging = patch.messaging;
    if (patch.doNotTrack !== undefined) this.forwardedDnt = patch.doNotTrack;
  }
  state(): ConsentState {
    const denies = (value: unknown) => value === '1' || value === 'yes';
    const browserDnt = (typeof navigator !== 'undefined' && denies(navigator.doNotTrack)) || (typeof window !== 'undefined' && denies((window as Window & { doNotTrack?: string }).doNotTrack));
    const doNotTrack = this.forwardedDnt || browserDnt;
    return { analytics: this.analytics && !doNotTrack, messaging: this.messaging && !doNotTrack, doNotTrack };
  }
}
