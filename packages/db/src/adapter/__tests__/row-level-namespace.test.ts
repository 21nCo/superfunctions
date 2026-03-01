/**
 * Unit tests for wrapWithRowLevelNamespace
 *
 * Covers test vectors: TV-RLN-001 through TV-RLN-013
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { memoryAdapter } from '../../adapters/memory/index.js';
import {
  wrapWithRowLevelNamespace,
  NamespaceRequiredError,
} from '../row-level-namespace.js';
import type { Adapter } from '../types.js';

describe('wrapWithRowLevelNamespace', () => {
  let baseAdapter: Adapter;
  let db: Adapter;

  beforeEach(() => {
    baseAdapter = memoryAdapter({ debug: false });
    db = wrapWithRowLevelNamespace(baseAdapter, {
      enabled: true,
    });
  });

  // -----------------------------------------------------------------------
  // TV-RLN-004: create stamps namespace
  // -----------------------------------------------------------------------
  describe('create (TV-RLN-004)', () => {
    it('stamps __ns on created record and strips from output', async () => {
      const result = await db.create({
        model: 'task',
        data: { id: 't1', title: 'Test' },
        namespace: 'user:A',
      });

      // Output should NOT contain __ns
      expect(result).toEqual({ id: 't1', title: 'Test' });

      // Raw storage SHOULD contain __ns
      const raw = await baseAdapter.findMany({
        model: 'task',
        where: [{ field: 'id', operator: 'eq', value: 't1' }],
      });
      expect(raw[0]).toMatchObject({ id: 't1', title: 'Test', __ns: 'user:A' });
    });
  });

  // -----------------------------------------------------------------------
  // TV-RLN-005: createMany stamps all records
  // -----------------------------------------------------------------------
  describe('createMany (TV-RLN-005)', () => {
    it('stamps every record with __ns', async () => {
      const results = await db.createMany({
        model: 'task',
        data: [{ id: 't1' }, { id: 't2' }],
        namespace: 'user:A',
      });

      // Output stripped
      expect(results[0]).not.toHaveProperty('__ns');
      expect(results[1]).not.toHaveProperty('__ns');

      // Raw storage has __ns
      const raw = await baseAdapter.findMany({ model: 'task', where: [] });
      expect(raw).toHaveLength(2);
      expect(raw[0].__ns).toBe('user:A');
      expect(raw[1].__ns).toBe('user:A');
    });
  });

  // -----------------------------------------------------------------------
  // TV-RLN-001: findMany with namespace returns only matching records
  // -----------------------------------------------------------------------
  describe('findMany isolation (TV-RLN-001)', () => {
    beforeEach(async () => {
      await db.create({
        model: 'task',
        data: { id: 't1', title: 'A task' },
        namespace: 'user:A',
      });
      await db.create({
        model: 'task',
        data: { id: 't2', title: 'B task' },
        namespace: 'user:B',
      });
    });

    it('returns only namespace A records', async () => {
      const results = await db.findMany({
        model: 'task',
        where: [],
        namespace: 'user:A',
      });
      expect(results).toEqual([{ id: 't1', title: 'A task' }]);
    });

    it('returns only namespace B records', async () => {
      const results = await db.findMany({
        model: 'task',
        where: [],
        namespace: 'user:B',
      });
      expect(results).toEqual([{ id: 't2', title: 'B task' }]);
    });
  });

  // -----------------------------------------------------------------------
  // TV-RLN-002: findMany with namespace + user filters
  // -----------------------------------------------------------------------
  describe('findMany with user filters (TV-RLN-002)', () => {
    beforeEach(async () => {
      await db.create({
        model: 'task',
        data: { id: 't1', title: 'Open', status: 'open' },
        namespace: 'user:A',
      });
      await db.create({
        model: 'task',
        data: { id: 't2', title: 'Done', status: 'done' },
        namespace: 'user:A',
      });
      await db.create({
        model: 'task',
        data: { id: 't3', title: 'Open B', status: 'open' },
        namespace: 'user:B',
      });
    });

    it('composes namespace filter with user WHERE correctly', async () => {
      const results = await db.findMany({
        model: 'task',
        where: [{ field: 'status', operator: 'eq', value: 'open' }],
        namespace: 'user:A',
      });
      expect(results).toEqual([{ id: 't1', title: 'Open', status: 'open' }]);
    });
  });

  // -----------------------------------------------------------------------
  // TV-RLN-003: delete cannot cross namespace boundary
  // -----------------------------------------------------------------------
  describe('delete cross-namespace (TV-RLN-003)', () => {
    beforeEach(async () => {
      await db.create({
        model: 'task',
        data: { id: 't1' },
        namespace: 'user:A',
      });
      await db.create({
        model: 'task',
        data: { id: 't2' },
        namespace: 'user:B',
      });
    });

    it('cannot delete records in another namespace', async () => {
      // Try to delete t2 as user:A — should match zero rows
      await db.delete({
        model: 'task',
        where: [{ field: 'id', operator: 'eq', value: 't2' }],
        namespace: 'user:A',
      });

      // t2 should still exist
      const results = await db.findMany({
        model: 'task',
        where: [],
        namespace: 'user:B',
      });
      expect(results).toEqual([{ id: 't2' }]);
    });
  });

  // -----------------------------------------------------------------------
  // TV-RLN-006 & TV-RLN-007: missing/empty namespace throws
  // -----------------------------------------------------------------------
  describe('mandatory namespace enforcement (TV-RLN-006, TV-RLN-007)', () => {
    it('throws NAMESPACE_REQUIRED when namespace is missing', async () => {
      await expect(
        db.findMany({ model: 'task', where: [] }),
      ).rejects.toThrow(NamespaceRequiredError);

      try {
        await db.findMany({ model: 'task', where: [] });
      } catch (e: any) {
        expect(e.code).toBe('NAMESPACE_REQUIRED');
      }
    });

    it('throws NAMESPACE_REQUIRED when namespace is empty string', async () => {
      await expect(
        db.create({ model: 'task', data: { id: 't1' }, namespace: '' }),
      ).rejects.toThrow(NamespaceRequiredError);
    });

    it('throws for all CRUD methods without namespace', async () => {
      await expect(db.create({ model: 'task', data: {} })).rejects.toThrow(
        NamespaceRequiredError,
      );
      await expect(
        db.createMany({ model: 'task', data: [{}] }),
      ).rejects.toThrow(NamespaceRequiredError);
      await expect(
        db.findOne({ model: 'task', where: [] }),
      ).rejects.toThrow(NamespaceRequiredError);
      await expect(
        db.findMany({ model: 'task', where: [] }),
      ).rejects.toThrow(NamespaceRequiredError);
      await expect(
        db.update({ model: 'task', where: [], data: {} }),
      ).rejects.toThrow(NamespaceRequiredError);
      await expect(
        db.updateMany({ model: 'task', where: [], data: {} }),
      ).rejects.toThrow(NamespaceRequiredError);
      await expect(
        db.delete({ model: 'task', where: [] }),
      ).rejects.toThrow(NamespaceRequiredError);
      await expect(
        db.deleteMany({ model: 'task', where: [] }),
      ).rejects.toThrow(NamespaceRequiredError);
      await expect(
        db.upsert({ model: 'task', where: [], create: {}, update: {} }),
      ).rejects.toThrow(NamespaceRequiredError);
      await expect(db.count({ model: 'task' })).rejects.toThrow(
        NamespaceRequiredError,
      );
    });
  });

  // -----------------------------------------------------------------------
  // TV-RLN-008: output stripping
  // -----------------------------------------------------------------------
  describe('output stripping (TV-RLN-008)', () => {
    it('strips __ns from findOne result', async () => {
      await db.create({
        model: 'task',
        data: { id: 't1', title: 'Test' },
        namespace: 'user:A',
      });

      const result = await db.findOne({
        model: 'task',
        where: [{ field: 'id', operator: 'eq', value: 't1' }],
        namespace: 'user:A',
      });

      expect(result).toEqual({ id: 't1', title: 'Test' });
      expect(result).not.toHaveProperty('__ns');
    });

    it('strips __ns from update result', async () => {
      await db.create({
        model: 'task',
        data: { id: 't1', title: 'Old' },
        namespace: 'user:A',
      });

      const result = await db.update({
        model: 'task',
        where: [{ field: 'id', operator: 'eq', value: 't1' }],
        data: { title: 'New' },
        namespace: 'user:A',
      });

      expect(result).not.toHaveProperty('__ns');
      expect(result).toMatchObject({ id: 't1', title: 'New' });
    });
  });

  // -----------------------------------------------------------------------
  // TV-RLN-009: update cannot change namespace
  // -----------------------------------------------------------------------
  describe('namespace immutability on updates (TV-RLN-009)', () => {
    it('strips __ns from update data', async () => {
      await db.create({
        model: 'task',
        data: { id: 't1', title: 'Old' },
        namespace: 'user:A',
      });

      await db.update({
        model: 'task',
        where: [{ field: 'id', operator: 'eq', value: 't1' }],
        data: { title: 'New', __ns: 'user:B' },
        namespace: 'user:A',
      });

      // Verify raw storage still has user:A
      const raw = await baseAdapter.findMany({
        model: 'task',
        where: [{ field: 'id', operator: 'eq', value: 't1' }],
      });
      expect(raw[0].__ns).toBe('user:A');
      expect(raw[0].title).toBe('New');
    });

    it('strips __ns from updateMany data', async () => {
      await db.create({
        model: 'task',
        data: { id: 't1', title: 'Old' },
        namespace: 'user:A',
      });

      await db.updateMany({
        model: 'task',
        where: [{ field: 'id', operator: 'eq', value: 't1' }],
        data: { title: 'New', __ns: 'user:B' },
        namespace: 'user:A',
      });

      const raw = await baseAdapter.findMany({
        model: 'task',
        where: [{ field: 'id', operator: 'eq', value: 't1' }],
      });
      expect(raw[0].__ns).toBe('user:A');
    });
  });

  // -----------------------------------------------------------------------
  // TV-RLN-010: internal CRUD not affected
  // -----------------------------------------------------------------------
  describe('internal CRUD exemption (TV-RLN-010)', () => {
    it('db.internal works without namespace injection', async () => {
      // Ensure an internal table
      await db.internal.ensureTable('__datafn_changes', [
        { name: 'id', type: 'text', primaryKey: true },
        { name: 'namespace', type: 'text' },
      ]);

      // Create a record — no NAMESPACE_REQUIRED error
      await db.internal.create('__datafn_changes', {
        id: 'c1',
        namespace: 'user:A',
      });

      // FindMany — no namespace injection
      const results = await db.internal.findMany('__datafn_changes', [
        { field: 'namespace', op: 'eq', value: 'user:A' },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ id: 'c1', namespace: 'user:A' });
    });
  });

  // -----------------------------------------------------------------------
  // TV-RLN-012: upsert stamps create but not update
  // -----------------------------------------------------------------------
  describe('upsert dual injection (TV-RLN-012)', () => {
    it('stamps __ns in create data for new record', async () => {
      const result = await db.upsert({
        model: 'task',
        where: [{ field: 'id', operator: 'eq', value: 't1' }],
        create: { id: 't1', title: 'New' },
        update: { title: 'Updated' },
        namespace: 'user:A',
      });

      expect(result).not.toHaveProperty('__ns');
      expect(result).toMatchObject({ id: 't1', title: 'New' });

      // Verify raw storage
      const raw = await baseAdapter.findMany({
        model: 'task',
        where: [{ field: 'id', operator: 'eq', value: 't1' }],
      });
      expect(raw[0].__ns).toBe('user:A');
    });

    it('does not change __ns on update path', async () => {
      // Create record first
      await db.create({
        model: 'task',
        data: { id: 't1', title: 'Original' },
        namespace: 'user:A',
      });

      // Upsert — should update, not create
      await db.upsert({
        model: 'task',
        where: [{ field: 'id', operator: 'eq', value: 't1' }],
        create: { id: 't1', title: 'New' },
        update: { title: 'Updated', __ns: 'user:B' },
        namespace: 'user:A',
      });

      const raw = await baseAdapter.findMany({
        model: 'task',
        where: [{ field: 'id', operator: 'eq', value: 't1' }],
      });
      expect(raw[0].__ns).toBe('user:A');
      expect(raw[0].title).toBe('Updated');
    });
  });

  // -----------------------------------------------------------------------
  // TV-RLN-013: disabled mode — no filtering
  // -----------------------------------------------------------------------
  describe('disabled mode (TV-RLN-013)', () => {
    let disabledDb: Adapter;

    beforeEach(() => {
      const base = memoryAdapter({ debug: false });
      disabledDb = wrapWithRowLevelNamespace(base, { enabled: false });
    });

    it('returns all records without namespace filtering', async () => {
      await disabledDb.create({
        model: 'task',
        data: { id: 't1' },
      });
      await disabledDb.create({
        model: 'task',
        data: { id: 't2' },
      });

      const results = await disabledDb.findMany({
        model: 'task',
        where: [],
      });
      expect(results).toHaveLength(2);
    });

    it('does not throw on missing namespace', async () => {
      await expect(
        disabledDb.findMany({ model: 'task', where: [] }),
      ).resolves.not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Custom column name
  // -----------------------------------------------------------------------
  describe('custom column name', () => {
    let customDb: Adapter;
    let customBase: Adapter;

    beforeEach(() => {
      customBase = memoryAdapter({ debug: false });
      customDb = wrapWithRowLevelNamespace(customBase, {
        enabled: true,
        columnName: 'tenant_id',
      });
    });

    it('uses custom column for stamping and filtering', async () => {
      await customDb.create({
        model: 'task',
        data: { id: 't1', title: 'Test' },
        namespace: 'tenant:acme',
      });

      // Raw has custom column
      const raw = await customBase.findMany({
        model: 'task',
        where: [{ field: 'id', operator: 'eq', value: 't1' }],
      });
      expect(raw[0].tenant_id).toBe('tenant:acme');
      expect(raw[0]).not.toHaveProperty('__ns');

      // Filtered correctly
      const results = await customDb.findMany({
        model: 'task',
        where: [],
        namespace: 'tenant:acme',
      });
      expect(results).toHaveLength(1);
      expect(results[0]).not.toHaveProperty('tenant_id');
    });
  });

  // -----------------------------------------------------------------------
  // count with namespace
  // -----------------------------------------------------------------------
  describe('count with namespace', () => {
    beforeEach(async () => {
      await db.create({ model: 'task', data: { id: 't1' }, namespace: 'user:A' });
      await db.create({ model: 'task', data: { id: 't2' }, namespace: 'user:A' });
      await db.create({ model: 'task', data: { id: 't3' }, namespace: 'user:B' });
    });

    it('counts only records in the given namespace', async () => {
      const countA = await db.count({ model: 'task', namespace: 'user:A' });
      expect(countA).toBe(2);

      const countB = await db.count({ model: 'task', namespace: 'user:B' });
      expect(countB).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // deleteMany with namespace
  // -----------------------------------------------------------------------
  describe('deleteMany with namespace', () => {
    beforeEach(async () => {
      await db.create({ model: 'task', data: { id: 't1' }, namespace: 'user:A' });
      await db.create({ model: 'task', data: { id: 't2' }, namespace: 'user:B' });
      await db.create({ model: 'task', data: { id: 't3' }, namespace: 'user:A' });
    });

    it('only deletes records in the given namespace', async () => {
      const deleted = await db.deleteMany({
        model: 'task',
        where: [],
        namespace: 'user:A',
      });
      expect(deleted).toBe(2);

      // user:B still has their record
      const remaining = await db.findMany({
        model: 'task',
        where: [],
        namespace: 'user:B',
      });
      expect(remaining).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // WHERE merge — existing conditions are AND-merged, not replaced
  // -----------------------------------------------------------------------
  describe('WHERE merge preserves existing conditions', () => {
    beforeEach(async () => {
      await db.create({
        model: 'task',
        data: { id: 't1', status: 'open' },
        namespace: 'user:A',
      });
      await db.create({
        model: 'task',
        data: { id: 't2', status: 'done' },
        namespace: 'user:A',
      });
    });

    it('findOne with existing where still works', async () => {
      const result = await db.findOne({
        model: 'task',
        where: [{ field: 'status', operator: 'eq', value: 'done' }],
        namespace: 'user:A',
      });
      expect(result).toMatchObject({ id: 't2', status: 'done' });
    });
  });
});
