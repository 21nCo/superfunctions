import type { Role, UserRole, AccessRequest } from '../types/index.js';
import type { IndexedDBStorage } from '../storage/indexeddb-storage.js';
import { generateId } from '../utils/helpers.js';

export interface AccessControlConfig {
  storage: IndexedDBStorage;
  cache?: {
    ttl: number;
    maxSize: number;
  };
}

export interface CreateRoleOptions {
  name: string;
  description: string;
  permissions: string[];
  inherits?: string[];
  metadata?: Record<string, unknown>;
}

export interface AssignRoleOptions {
  resourceIds?: string[];
  expiresAt?: number;
}

interface CacheEntry {
  allowed: boolean;
  timestamp: number;
}

export class AccessControl {
  private storage: IndexedDBStorage;
  private cache: Map<string, CacheEntry>;
  private cacheTTL: number;
  private maxCacheSize: number;

  constructor(config: AccessControlConfig) {
    this.storage = config.storage;
    this.cache = new Map();
    this.cacheTTL = config.cache?.ttl || 300000;
    this.maxCacheSize = config.cache?.maxSize || 1000;
  }

  async createRole(options: CreateRoleOptions): Promise<string> {
    const role: Role = {
      id: generateId('role'),
      name: options.name,
      description: options.description,
      permissions: options.permissions,
      inherits: options.inherits,
      metadata: options.metadata,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.storage.saveRole(role);
    return role.id;
  }

  async getRole(id: string): Promise<Role | null> {
    return await this.storage.getRole(id);
  }

  async getRoleByName(name: string): Promise<Role | null> {
    const roles = await this.storage.listRoles();
    return roles.find(r => r.name === name) || null;
  }

  async listRoles(): Promise<Role[]> {
    return await this.storage.listRoles();
  }

  async updateRole(id: string, updates: Partial<CreateRoleOptions>): Promise<void> {
    const role = await this.storage.getRole(id);
    if (!role) {
      throw new Error(`Role ${id} not found`);
    }

    if (updates.name) role.name = updates.name;
    if (updates.description) role.description = updates.description;
    if (updates.permissions) role.permissions = updates.permissions;
    if (updates.inherits) role.inherits = updates.inherits;
    if (updates.metadata) role.metadata = updates.metadata;
    role.updatedAt = Date.now();

    await this.storage.saveRole(role);
    this.invalidateCache();
  }

  async deleteRole(id: string): Promise<void> {
    await this.storage.deleteRole(id);
    this.invalidateCache();
  }

  async assignRole(userId: string, roleId: string, options: AssignRoleOptions = {}): Promise<void> {
    const role = await this.storage.getRole(roleId);
    if (!role) {
      throw new Error(`Role ${roleId} not found`);
    }

    const userRole: UserRole = {
      userId,
      roleId,
      resourceIds: options.resourceIds,
      expiresAt: options.expiresAt,
      assignedAt: Date.now(),
    };

    await this.storage.assignUserRole(userRole);
    this.invalidateCacheForUser(userId);
  }

  async removeRole(userId: string, roleId: string): Promise<void> {
    await this.storage.removeUserRole(userId, roleId);
    this.invalidateCacheForUser(userId);
  }

  async getUserRoles(userId: string): Promise<Role[]> {
    const userRoles = await this.storage.getUserRoles(userId);
    const roles: Role[] = [];

    for (const userRole of userRoles) {
      if (userRole.expiresAt && Date.now() > userRole.expiresAt) {
        continue;
      }

      const role = await this.storage.getRole(userRole.roleId);
      if (role) {
        roles.push(role);
      }
    }

    return roles;
  }

  async getUserPermissions(userId: string): Promise<string[]> {
    const roles = await this.getUserRoles(userId);
    const permissions = new Set<string>();

    for (const role of roles) {
      await this.collectPermissions(role, permissions);
    }

    return Array.from(permissions);
  }

  async check(request: AccessRequest): Promise<boolean> {
    const cacheKey = this.getCacheKey(request);
    const cached = this.getCached(cacheKey);

    if (cached !== null) {
      return cached;
    }

    const allowed = await this.evaluateAccess(request);
    this.setCached(cacheKey, allowed);

    return allowed;
  }

  private async evaluateAccess(request: AccessRequest): Promise<boolean> {
    const userRoles = await this.storage.getUserRoles(request.userId);

    for (const userRole of userRoles) {
      if (userRole.expiresAt && Date.now() > userRole.expiresAt) {
        continue;
      }

      if (userRole.resourceIds && request.resourceId) {
        if (!userRole.resourceIds.includes(request.resourceId)) {
          continue;
        }
      }

      const role = await this.storage.getRole(userRole.roleId);
      if (!role) continue;

      const hasPermission = await this.checkRolePermission(role, request);
      if (hasPermission) {
        return true;
      }
    }

    return false;
  }

  private async checkRolePermission(role: Role, request: AccessRequest): Promise<boolean> {
    const allPermissions = new Set<string>();
    await this.collectPermissions(role, allPermissions);

    for (const permission of allPermissions) {
      if (this.matchesPermission(permission, request.action)) {
        return true;
      }
    }

    return false;
  }

  private async collectPermissions(role: Role, collected: Set<string>): Promise<void> {
    for (const permission of role.permissions) {
      collected.add(permission);
    }

    if (role.inherits) {
      for (const inheritedRoleId of role.inherits) {
        const inheritedRole = await this.storage.getRole(inheritedRoleId);
        if (inheritedRole) {
          await this.collectPermissions(inheritedRole, collected);
        }
      }
    }
  }

  private matchesPermission(permission: string, action: string): boolean {
    if (permission === '*:*') return true;

    const [permResource, permAction] = permission.split(':');
    const [reqResource, reqAction] = action.split(':');

    if (!permResource || !permAction || !reqResource || !reqAction) {
      return false;
    }

    const resourceMatch = permResource === '*' || permResource === reqResource;
    const actionMatch = permAction === '*' || permAction === reqAction;

    return resourceMatch && actionMatch;
  }

  private getCacheKey(request: AccessRequest): string {
    return `${request.userId}:${request.action}:${request.resourceId || '*'}`;
  }

  private getCached(key: string): boolean | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const age = Date.now() - entry.timestamp;
    if (age > this.cacheTTL) {
      this.cache.delete(key);
      return null;
    }

    return entry.allowed;
  }

  private setCached(key: string, allowed: boolean): void {
    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }

    this.cache.set(key, {
      allowed,
      timestamp: Date.now(),
    });
  }

  private invalidateCache(): void {
    this.cache.clear();
  }

  private invalidateCacheForUser(userId: string): void {
    for (const [key] of this.cache) {
      if (key.startsWith(`${userId}:`)) {
        this.cache.delete(key);
      }
    }
  }
}
