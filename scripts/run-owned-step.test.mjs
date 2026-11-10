import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const wrapper = fileURLToPath(new URL('./run-owned-step.mjs', import.meta.url));
test('timeout retires a hanging command and its descendant', {skip:process.platform === 'win32'}, async () => {
  const root = mkdtempSync(join(tmpdir(),'owned-step-'));
  const pidFile = join(root,'pid');
  let descendant;
  try {
    const source = `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`;
    const child = spawn(process.execPath,[wrapper,'500',process.execPath,'-e',source],{stdio:'pipe'});
    const code = await new Promise((resolve,reject) => {child.once('error',reject);child.once('close',resolve);});
    assert.equal(code,124);
    descendant = Number(readFileSync(pidFile,'utf8'));
    let alive = true;
    for(let attempt=0; attempt<100 && alive; attempt++) {
      try {process.kill(descendant,0);await new Promise(resolve=>setTimeout(resolve,20));}
      catch(error) {assert.equal(error.code,'ESRCH');alive=false;}
    }
    assert.equal(alive,false,'descendant survived timeout');
  } finally {
    if(descendant) {try{process.kill(descendant,'SIGKILL');}catch{}}
    rmSync(root,{recursive:true,force:true});
  }
});
