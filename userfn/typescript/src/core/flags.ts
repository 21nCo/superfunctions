import { FlagConfig, FlagValue, UserIdentity } from '../types';

export class FlagEvaluator {
  private flags: Map<string, FlagConfig> = new Map();

  constructor(initialFlags: FlagConfig[] = []) {
    initialFlags.forEach(flag => this.flags.set(flag.key, flag));
  }

  setFlags(flags: FlagConfig[]) {
    this.flags.clear();
    flags.forEach(flag => this.flags.set(flag.key, flag));
  }

  getFlag(key: string, defaultValue: FlagValue, user?: UserIdentity | null): FlagValue {
    const flag = this.flags.get(key);
    
    if (!flag) {
      return defaultValue;
    }

    if (!flag.enabled) {
      return defaultValue;
    }

    // TODO: Implement advanced rule evaluation (segments, rollouts)
    // For now, return the default variation or the first variation
    
    // Simple mock logic: if user is present, maybe use a deterministic hash to pick variation?
    // Let's just return the flag's configured default for Phase 0.
    return flag.defaultValue;
  }
}
