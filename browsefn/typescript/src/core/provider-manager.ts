/**
 * Provider manager for orchestrating multiple providers with fallback
 */

import type { WebProvider, ImageProvider, GeoProvider } from './types.js';

export class ProviderManager<T extends WebProvider | ImageProvider | GeoProvider> {
  private providers = new Map<string, T>();
  private availabilityCache = new Map<string, { available: boolean; timestamp: number }>();
  private readonly AVAILABILITY_CACHE_TTL = 60000; // 1 minute

  constructor(
    private defaultProvider?: string,
    private fallbackChain: string[] = []
  ) {}

  /**
   * Register a provider
   */
  register(name: string, provider: T): void {
    this.providers.set(name, provider);
  }

  /**
   * Get provider by name
   */
  get(name: string): T | undefined {
    return this.providers.get(name);
  }

  /**
   * Get default provider
   */
  getDefault(): T | undefined {
    if (this.defaultProvider) {
      return this.providers.get(this.defaultProvider);
    }
    // Return first available provider
    return this.providers.values().next().value;
  }

  /**
   * Check if provider is available (with caching)
   */
  async isAvailable(name: string): Promise<boolean> {
    const provider = this.providers.get(name);
    if (!provider) return false;

    // Check cache
    const cached = this.availabilityCache.get(name);
    if (cached && Date.now() - cached.timestamp < this.AVAILABILITY_CACHE_TTL) {
      return cached.available;
    }

    // Check availability
    try {
      const available = await provider.isAvailable();
      this.availabilityCache.set(name, { available, timestamp: Date.now() });
      return available;
    } catch (error) {
      this.availabilityCache.set(name, { available: false, timestamp: Date.now() });
      return false;
    }
  }

  /**
   * Get fallback chain with default provider first
   */
  getFallbackChain(requestedProvider?: string): string[] {
    const chain: string[] = [];

    // Add requested provider first
    if (requestedProvider && this.providers.has(requestedProvider)) {
      chain.push(requestedProvider);
    }

    // Add default provider if not already in chain
    if (this.defaultProvider && !chain.includes(this.defaultProvider)) {
      chain.push(this.defaultProvider);
    }

    // Add fallback chain
    for (const provider of this.fallbackChain) {
      if (!chain.includes(provider) && this.providers.has(provider)) {
        chain.push(provider);
      }
    }

    // Add any remaining providers
    for (const provider of this.providers.keys()) {
      if (!chain.includes(provider)) {
        chain.push(provider);
      }
    }

    return chain;
  }

  /**
   * Execute with fallback
   */
  async executeWithFallback<R>(
    requestedProvider: string | undefined,
    executor: (provider: T, providerName: string) => Promise<R>,
    onFallback?: (from: string, to: string, error: Error) => void
  ): Promise<R> {
    const chain = this.getFallbackChain(requestedProvider);
    const errors: Array<{ provider: string; error: Error }> = [];

    for (let i = 0; i < chain.length; i++) {
      const providerName = chain[i];
      const provider = this.providers.get(providerName);

      if (!provider) continue;

      // Check availability
      const available = await this.isAvailable(providerName);
      if (!available) {
        errors.push({
          provider: providerName,
          error: new Error(`Provider ${providerName} is not available`)
        });
        continue;
      }

      try {
        const result = await executor(provider, providerName);
        return result;
      } catch (error) {
        errors.push({ provider: providerName, error: error as Error });

        // Notify fallback if not the last provider
        if (i < chain.length - 1 && onFallback) {
          onFallback(providerName, chain[i + 1], error as Error);
        }
      }
    }

    // All providers failed
    const errorMessage = errors
      .map(e => `${e.provider}: ${e.error.message}`)
      .join('; ');
    throw new Error(`All providers failed: ${errorMessage}`);
  }

  /**
   * List all registered providers
   */
  list(): string[] {
    return Array.from(this.providers.keys()).sort();
  }

  /**
   * List all available providers
   */
  async listAvailable(): Promise<string[]> {
    const available: string[] = [];

    for (const name of this.providers.keys()) {
      if (await this.isAvailable(name)) {
        available.push(name);
      }
    }

    return available.sort();
  }

  /**
   * Clear availability cache
   */
  clearAvailabilityCache(): void {
    this.availabilityCache.clear();
  }
}
