import { UserIdentity, UserTraits } from '../types';

export class IdentityManager {
  private currentUser: UserIdentity | null = null;

  constructor() {}

  identify(id: string, traits: UserTraits = {}): void {
    this.currentUser = {
      id,
      traits,
    };
    // In a real implementation, this would persist to local storage/cookies
  }

  getUser(): UserIdentity | null {
    return this.currentUser;
  }

  reset(): void {
    this.currentUser = null;
  }

  getTraits(): UserTraits {
    return this.currentUser?.traits || {};
  }

  getUserId(): string | undefined {
    return this.currentUser?.id;
  }
}
