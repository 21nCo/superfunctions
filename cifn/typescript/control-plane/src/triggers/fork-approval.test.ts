import { expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createApp } from '../api/routes.js';
import { MemoryStore } from '../store/memory-store.js';
import { MemoryQueueClient, DEFAULT_QUEUE_NAME } from '../queue/flowfn-client.js';
import { MemorySecFnClient } from '../secrets/secfn-client.js';
import { snapshotForkApprovals, type ForkApproval } from './fork-approval.js';
const approval: ForkApproval = { id: 'approved-code', baseRepositoryId: 1, baseRepository: 'base/repo', baseRepositoryUrl: 'https://github.com/base/repo.git', baseSha: 'a'.repeat(40), headRepositoryId: 2, headRepository: 'fork/repo', headRepositoryUrl: 'https://github.com/fork/repo.git', headSha: 'b'.repeat(40) };
const payload = () => {
  const base = { id: 1, full_name: 'base/repo', clone_url: approval.baseRepositoryUrl };
  return { action: 'synchronize', repository: base, pull_request: { base: { repo: base, sha: approval.baseSha, ref: 'main' }, head: { repo: { id: 2, full_name: 'fork/repo', clone_url: approval.headRepositoryUrl }, sha: approval.headSha, ref: 'feature' } }, cifnAdmission: { forkApproval: { allowedSecrets: ['SECRET'] } }, forkApprovals: [approval] };
};
function setup(approvals?: readonly ForkApproval[], env?: Record<string,string>) {
  const store = new MemoryStore(), queue = new MemoryQueueClient(), secFn = new MemorySecFnClient();
  const pipelineResolver = vi.fn(async (_ref: unknown) => ({ doc: JSON.stringify({ on: { pull_request: { branches: ['main'] } }, env, jobs: { build: { 'runs-on': 'default', steps: [{ uses: 'checkout' }] } } }), resolvedConfigPath: 'cifn.yml' }));
  const secretRead = vi.spyOn(secFn, 'getSecret');
  const { app } = createApp({ store, queue, secFn, pipelineResolver, webhookSecret: 'owned', forkApprovals: approvals });
  return { store, queue, secFn, secretRead, pipelineResolver, app };
}
async function send(app: ReturnType<typeof createApp>['app'], value = payload()) {
  const body = JSON.stringify(value);
  return app.request('http://owned.invalid/webhooks/github', { method: 'POST', headers: { 'X-GitHub-Event': 'pull_request', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256','owned').update(body).digest('hex') }, body });
}
it('defaults to denial and ignores approvals supplied by payload', async () => {
  const s=setup(); expect((await send(s.app)).status).toBe(403); expect(s.pipelineResolver).not.toHaveBeenCalled(); expect(s.secretRead).not.toHaveBeenCalled(); expect(s.store.listRuns().runs).toEqual([]);
});
it('uses detached host approval and persists distinct trusted config/head checkout provenance', async () => {
  const mutable = [{ ...approval, allowedSecrets: [] as string[] }]; const s=setup(mutable);
  mutable[0].headSha='c'.repeat(40); mutable[0].allowedSecrets.push('SECRET'); mutable.splice(0);
  expect((await send(s.app)).status).toBe(201);
  expect(s.pipelineResolver).toHaveBeenCalledWith({ repo: approval.baseRepositoryUrl, ref: approval.baseSha });
  const run=s.store.listRuns().runs[0];
  expect(run.pipelineRef).toMatchObject({repo:approval.headRepositoryUrl,ref:approval.headSha});
  expect(run.trigger.payload).toMatchObject({cifnAdmission:{configuration:{repo:approval.baseRepositoryUrl,ref:approval.baseSha,configPath:'cifn.yml'},execution:{repo:approval.headRepositoryUrl,ref:approval.headSha},forkApproval:{id:approval.id,allowedSecrets:[]}}});
  expect(s.queue.size(DEFAULT_QUEUE_NAME)).toBe(1);
  expect(s.queue.peek(DEFAULT_QUEUE_NAME)[0].trigger).toEqual(run.trigger);
});
it('invalidates approval on updated base/head SHA or identity and does not resolve credentials', async () => {
  for (const mutate of [(p: ReturnType<typeof payload>)=>{p.pull_request.head.sha='c'.repeat(40)},(p: ReturnType<typeof payload>)=>{p.pull_request.base.sha='c'.repeat(40)},(p: ReturnType<typeof payload>)=>{p.pull_request.head.repo.id=3},(p: ReturnType<typeof payload>)=>{p.pull_request.head.repo.clone_url='https://github.com/other/repo.git'},(p: ReturnType<typeof payload>)=>{p.repository.id=3}]) {
    const s=setup([approval]),p=payload(); mutate(p); expect([400,403]).toContain((await send(s.app,p)).status); expect(s.pipelineResolver).not.toHaveBeenCalled(); expect(s.secretRead).not.toHaveBeenCalled(); expect(s.queue.size(DEFAULT_QUEUE_NAME)).toBe(0);
  }
});
it('denies every undeclared secret before any read, permits only host-authorized names', async () => {
  const s=setup([approval],{TOKEN:'${{ secrets.SECRET }}'}); await s.secFn.setSecret('SECRET','private');
  expect((await send(s.app)).status).toBe(403); expect(s.secretRead).not.toHaveBeenCalled(); expect(s.store.listRuns().runs).toEqual([]);
  const allowed=setup([{...approval,allowedSecrets:['SECRET']}],{TOKEN:'${{ secrets.SECRET }}'});await allowed.secFn.setSecret('SECRET','private');expect((await send(allowed.app)).status).toBe(201);expect(allowed.secretRead).toHaveBeenCalledExactlyOnceWith('SECRET');
});
it('rejects malformed policy and credential-bearing repository URLs without reflecting credentials', async () => {
  expect(()=>snapshotForkApprovals([{...approval,headRepositoryUrl:'https://user:private@github.com/fork/repo.git'}])).toThrow('Invalid fork approval');
  expect(()=>snapshotForkApprovals([{...approval,allowedSecrets:['SECRET',42] as unknown as string[]}])).toThrow('Invalid fork approval');
  const s=setup([approval]),p=payload();p.pull_request.head.repo.clone_url='https://user:private@github.com/fork/repo.git';const response=await send(s.app,p);expect(response.status).toBe(400);expect(await response.text()).not.toContain('private');expect(s.pipelineResolver).not.toHaveBeenCalled();
});
