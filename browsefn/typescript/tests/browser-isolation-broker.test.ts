import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { removeOwnedBrowserContainer } from '../src/web/isolation/lifecycle.js';
import { launchIsolatedBrowser } from '../src/web/isolation/docker-browser.js';
vi.mock('node:child_process',()=>({spawn:vi.fn()}));
vi.mock('../src/web/isolation/lifecycle.js',()=>({removeOwnedBrowserContainer:vi.fn(async()=>{})}));
afterEach(()=>vi.resetAllMocks());
function worker(output:string){
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn()});
  vi.mocked(spawn).mockImplementation((()=>{
    child.stdin.once('data',()=>setImmediate(()=>child.stdout.write(output)));
    return child;
  }) as never);
  return child;
}
it.each(['not-json\n',JSON.stringify({type:'unknown'})+'\n','x'.repeat(262145),JSON.stringify({type:'data',data:'x'.repeat(131073)})+'\n'])('closes malformed or oversized worker frames without leaving the owned process',async output=>{
  const child=worker(output);
  await expect(launchIsolatedBrowser({dockerImage:'owned-fixture'},'playwright','chromium',1000)).rejects.toMatchObject({code:'PROVIDER_UNAVAILABLE'});
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');expect(child.stdin.destroyed).toBe(true);
  expect(removeOwnedBrowserContainer).toHaveBeenCalledOnce();
  expect(removeOwnedBrowserContainer).toHaveBeenCalledWith(expect.stringMatching(/^browsefn-[a-f0-9-]{36}$/));
});
it('surfaces cleanup uncertainty when a failed worker cannot be confirmed absent',async()=>{
  worker('not-json\n');
  vi.mocked(removeOwnedBrowserContainer).mockRejectedValue(new Error('Could not confirm isolated browser cleanup.'));
  await expect(launchIsolatedBrowser({dockerImage:'owned-fixture'},'playwright','chromium',1000)).rejects.toThrow('Could not confirm isolated browser cleanup.');
});
