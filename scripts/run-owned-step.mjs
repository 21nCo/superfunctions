#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

// One bounded process group per gate step. On completion, also retire orphaned
// descendants that closed their inherited pipes or outlived the direct child.
const [timeoutText, command, ...args] = process.argv.slice(2);
const timeoutMs = Number(timeoutText);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647 || !command) throw new Error('Usage: run-owned-step.mjs <timeout-ms> <command> [args...]');
const child = spawn(command, args, {stdio:'inherit', detached:process.platform !== 'win32'});
let failureCode;
let escalation;
function kill(signal) {
  if (!child.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else if (process.env.SystemRoot && path.win32.isAbsolute(process.env.SystemRoot)) {
      spawnSync(path.win32.join(process.env.SystemRoot,'System32/taskkill.exe'), ['/pid',String(child.pid),'/T','/F'], {timeout:2000,stdio:'ignore',windowsHide:true});
    } else child.kill(signal);
  } catch (error) { if (error.code !== 'ESRCH') console.error(`Gate process cleanup failed: ${error.message}`); }
}
function stop(code) {
  if (failureCode !== undefined) return;
  failureCode = code;
  kill('SIGTERM');
  escalation = setTimeout(() => kill('SIGKILL'), 2000);
}
const ownerPid = process.ppid;
const ownerWatch = setInterval(() => { if (process.ppid !== ownerPid) stop(143); }, 250);
const timeout = setTimeout(() => { console.error(`Gate step exceeded ${timeoutMs}ms`); stop(124); }, timeoutMs);
const interrupt = () => stop(130);
const terminate = () => stop(143);
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);
function finish(code) {
  clearTimeout(timeout);
  clearInterval(ownerWatch);
  clearTimeout(escalation);
  process.removeListener('SIGINT',interrupt);
  process.removeListener('SIGTERM',terminate);
  kill('SIGKILL');
  process.exitCode = failureCode ?? code ?? 1;
}
child.once('error', error => { console.error(error.message); finish(1); });
child.once('close', code => finish(code));
