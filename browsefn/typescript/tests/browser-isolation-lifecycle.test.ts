import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { browserDeadline, removeOwnedBrowserContainer } from '../src/web/isolation/lifecycle.js';
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
const name='browsefn-01234567-89ab-cdef-0123-456789abcdef';
afterEach(()=>{vi.resetAllMocks();vi.useRealTimers();});
function commands(results:Array<{failed:boolean;stderr?:string}>) {
  vi.mocked(execFile).mockImplementation(((_bin:unknown,_args:unknown,_opts:unknown,callback:Function)=>{
    const result=results.shift();if(!result) throw new Error('Unexpected command');
    callback(result.failed?new Error('command failed'):null,'',result.stderr??'');
    return {};
  }) as never);
}
it('requires confirmed absence even when removal failed',async()=>{
  commands([{failed:true,stderr:'removal already in progress'},{failed:false},{failed:true,stderr:'Error: No such object: '+name}]);
  await expect(removeOwnedBrowserContainer(name)).resolves.toBeUndefined();expect(execFile).toHaveBeenCalledTimes(3);
});
it('does not convert unavailable Docker daemon or removal timeout into cleanup success',async()=>{
  commands([{failed:true,stderr:'timeout'},{failed:true,stderr:'Cannot connect to Docker daemon'}]);
  await expect(removeOwnedBrowserContainer(name)).rejects.toMatchObject({code:'PROVIDER_ERROR',message:'Could not confirm isolated browser cleanup.'});
});
it('does not remove names outside the owned UUID namespace',async()=>{
  await expect(removeOwnedBrowserContainer('postgres')).rejects.toMatchObject({code:'PROVIDER_ERROR'});expect(execFile).not.toHaveBeenCalled();
});
it('bounds pending DNS-style preflight work with the whole-operation deadline',async()=>{
  vi.useFakeTimers();const deadline=browserDeadline(100);const result=deadline.wait(new Promise(()=>{}));
  const rejection=expect(result).rejects.toMatchObject({code:'UPSTREAM_TIMEOUT'});
  await vi.advanceTimersByTimeAsync(100);await rejection;expect(vi.getTimerCount()).toBe(0);
});
it('does not extend the deadline for later browser phases',async()=>{
  vi.useFakeTimers();const deadline=browserDeadline(100);await vi.advanceTimersByTimeAsync(80);expect(deadline.remaining()).toBe(20);
  await vi.advanceTimersByTimeAsync(21);expect(()=>deadline.remaining()).toThrow();
});
