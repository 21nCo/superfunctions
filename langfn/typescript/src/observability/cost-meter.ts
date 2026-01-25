import { TokenUsage, Cost } from "../core/types.js";

export interface modelCost {
  prompt: number; // per 1k tokens
  completion: number; // per 1k tokens
}

const COST_MAP: Record<string, Record<string, modelCost>> = {
  openai: {
    "gpt-4": { prompt: 0.03, completion: 0.06 },
    "gpt-4-turbo-preview": { prompt: 0.01, completion: 0.03 },
    "gpt-4o": { prompt: 0.005, completion: 0.015 },
    "gpt-4o-mini": { prompt: 0.00015, completion: 0.0006 },
    "gpt-3.5-turbo": { prompt: 0.0005, completion: 0.0015 }
  },
  anthropic: {
    "claude-3-opus-20240229": { prompt: 0.015, completion: 0.075 },
    "claude-3-sonnet-20240229": { prompt: 0.003, completion: 0.015 },
    "claude-3-haiku-20240307": { prompt: 0.00025, completion: 0.00125 }
  }
};

export class CostMeter {
  estimate(provider: string, model: string, usage: TokenUsage): Cost {
    const rates = COST_MAP[provider]?.[model] || { prompt: 0, completion: 0 };
    
    const promptCost = (usage.prompt_tokens / 1000) * rates.prompt;
    const completionCost = (usage.completion_tokens / 1000) * rates.completion;
    
    return {
      prompt: promptCost,
      completion: completionCost,
      total: promptCost + completionCost,
      currency: "USD"
    };
  }
}
