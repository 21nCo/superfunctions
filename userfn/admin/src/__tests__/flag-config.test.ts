import { describe, expect, it } from 'vitest';
import { validateAdminValue } from '@superfunctions/admin';
import { MemoryUserFnOperatorStore, UserFnOperatorService, type FlagConfig } from 'userfn/operator';
import { createUserFnAdminAdapter, createUserFnOperatorAdminService, userFnAdminCapability } from '../index.js';
const scope = { installationId: 'flags-install', workspaceId: 'flags-workspace', projectId: 'flags-project', environmentId: 'production' };
const context = { scope, actor: { id: 'operator', permissions: ['*'] }, requestId: 'flags-request', source: 'console' as const, idempotencyKey: 'flags-idem', confirmationToken: 'confirmed' };
const config: FlagConfig = {
  key: 'checkout', enabled: true, defaultValue: false, defaultVariationId: 'on', variations: [{ id: 'on', value: true }], rules: [],
  prerequisites: [{ key: 'billing', expectedValue: { ready: true, version: 2 } }],
  environmentOverrides: { staging: { defaultValue: 0, defaultVariationId: null, rules: [] }, production: { enabled: false } },
};
describe('admin flag configuration round trip', () => {
  it('preserves prerequisites and environment overrides through save, list and global toggle', async () => {
    const store = new MemoryUserFnOperatorStore();
    const adapter = createUserFnAdminAdapter(createUserFnOperatorAdminService(new UserFnOperatorService(store)));
    const definition = userFnAdminCapability.operations.find(operation => operation.id === 'userfn.flags.save')!;
    expect(validateAdminValue(definition.inputSchema, { flag: config })).toEqual([]);
    const saved = await adapter.invoke('userfn.flags.save', { flag: config }, context);
    expect(saved.data).toEqual({ item: config });
    expect(validateAdminValue(definition.outputSchema, saved.data)).toEqual([]);
    const listed = await adapter.invoke('userfn.flags.list', {}, context);
    expect(listed.data).toMatchObject({ items: [config] });
    const toggled = await adapter.invoke('userfn.flags.set-enabled', { id: config.key, enabled: false }, context);
    expect(toggled.data).toEqual({ item: { ...config, enabled: false } });
    expect(await store.listFlags(scope)).toEqual([{ ...config, enabled: false }]);
    expect(await store.listFlags({ ...scope, environmentId: 'other' })).toEqual([]);
    await expect(adapter.invoke('userfn.flags.set-enabled', { id: config.key, enabled: 'yes' }, context)).rejects.toThrow(TypeError);
    expect(await store.listFlags(scope)).toEqual([{ ...config, enabled: false }]);
  });

  it('rejects malformed new fields instead of silently dropping them', async () => {
    const store = new MemoryUserFnOperatorStore();
    const adapter = createUserFnAdminAdapter(createUserFnOperatorAdminService(new UserFnOperatorService(store)));
    for (const patch of [
      { prerequisites: [{ key: 'billing' }] },
      { environmentOverrides: { staging: { prerequisites: [] } } },
      { environmentOverrides: { staging: { enabled: 'yes' } } },
    ]) {
      const input = { flag: { ...config, ...patch } };
      const definition = userFnAdminCapability.operations.find(operation => operation.id === 'userfn.flags.save')!;
      expect(validateAdminValue(definition.inputSchema, input).length).toBeGreaterThan(0);
      await expect(adapter.invoke('userfn.flags.save', input, context)).rejects.toThrow(TypeError);
    }
    expect(await store.listFlags(scope)).toEqual([]);
  });
});


it('round trips startsWith through flag and segment admin operations',async()=>{
 const store=new MemoryUserFnOperatorStore();const adapter=createUserFnAdminAdapter(createUserFnOperatorAdminService(new UserFnOperatorService(store)));
 const rule={id:'prefix',field:'plan',operator:'startsWith' as const,value:'pro'};
 const flag={...config,prerequisites:[],rules:[{id:'prefix-rule',constraints:[rule],variationId:'on'}]};
 const saved=await adapter.invoke('userfn.flags.save',{flag},context);expect(saved.data).toEqual({item:flag});
 const segment={id:'prefix-segment',name:'Prefix',rules:[rule]};
 const savedSegment=await adapter.invoke('userfn.segments.save',{segment},context);expect(savedSegment.data).toEqual({item:segment});
 expect(await store.listSegments(scope)).toEqual([segment]);
});
