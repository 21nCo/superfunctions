import { SendfnDatabaseAdapter, FindSuppressionParams } from '../database/adapter';
import { SuppressionList, CreateSuppression } from '../types';

export interface SuppressionCheckResult {
  suppressed: boolean;
  entry?: SuppressionList | null;
  reason?: string;
}

export type AddSuppressionParams = CreateSuppression;

export class SuppressionManager {
  constructor(
    private adapter: SendfnDatabaseAdapter,
    private options: { enabled: boolean }
  ) {}

  async checkSuppression(email: string): Promise<SuppressionCheckResult> {
    if (!this.options.enabled) {
        return { suppressed: false };
    }

    const entry = await this.adapter.getSuppressionListEntry(email);
    if (entry) {
        return {
            suppressed: true,
            entry,
            reason: entry.reason
        };
    }

    return { suppressed: false };
  }

  async addToSuppressionList(params: AddSuppressionParams): Promise<SuppressionList> {
    return this.adapter.addToSuppressionList(params);
  }

  async removeFromSuppressionList(email: string): Promise<void> {
    return this.adapter.removeFromSuppressionList(email);
  }

  async findSuppressionList(params: FindSuppressionParams): Promise<SuppressionList[]> {
    return this.adapter.findSuppressionList(params);
  }
}
