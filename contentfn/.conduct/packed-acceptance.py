"""Run after building ContentFn and its shared prerequisites. Keeps isolated consumers for inspection."""
import pathlib,subprocess,json,tempfile,shutil
root=pathlib.Path(__file__).resolve().parents[2]
fixtures=pathlib.Path(__file__).resolve().parent
out=pathlib.Path(tempfile.mkdtemp(prefix='contentfn-target-packed-'))
print(out,flush=True)
paths=['packages/observability','packages/db','packages/http','packages/storage','mdfn/core','mdfn/markdown','mdfn/extensions','mdfn/contentfn','contentfn/core','contentfn/client','contentfn/server','contentfn/cli','mcpfn/core','packages/admin','contentfn/admin']
packages={}
for path in paths:
 manifest=json.loads((root/path/'package.json').read_text())
 result=subprocess.run(['npm','pack','--ignore-scripts','--json','--pack-destination',str(out)],cwd=root/path,check=True,capture_output=True,text=True)
 packages[manifest['name']]='file:'+str(out/json.loads(result.stdout)[0]['filename'])
admin={'@mcpfn/core','@superfunctions/admin','@contentfn/admin'}
for mode in ['core','admin','node18']:
 target=out/mode;target.mkdir()
 deps={name:value for name,value in packages.items() if (name in admin if mode=='admin' else name in {'@contentfn/core','@contentfn/client','@contentfn/cli'} if mode=='node18' else name not in admin)}
 (target/'package.json').write_text(json.dumps({'private':True,'type':'module','dependencies':deps,'devDependencies':{'typescript':'5.9.3','@types/node':'22.19.0'}}))
 with (out/(mode+'-install.log')).open('w') as log:subprocess.run(['npx','--yes','npm@11.21.0','install','--ignore-scripts'],cwd=target,stdout=log,stderr=subprocess.STDOUT,check=True)
 with (out/(mode+'-audit.json')).open('w') as log:subprocess.run(['npm','audit','--omit=dev','--json'],cwd=target,stdout=log,check=True)
 if mode=='core':
  shutil.copyfile(fixtures/'packed-runtime.mjs',target/'runtime.mjs')
  (target/'consumer.mts').write_text("import { createContentfnServer } from '@contentfn/server';\nimport { memoryAdapter } from '@superfunctions/db/adapters/memory';\nconst server = createContentfnServer({ db: memoryAdapter() });\nvoid server.api.webhooks.deliveries({dataset:'prod',webhookId:'one'});\nvoid server.api.audit.query({dataset:'prod',limit:10}).then(response => { if (response.ok) { const actor: string | undefined = response.result.records[0]?.actor?.subject; void actor; } });\n")
  (target/'consumer.cts').write_text("import server = require('@contentfn/server');\nimport client = require('@contentfn/client');\nimport core = require('@contentfn/core');\nvoid server.createContentfnServer; void client.createContentfnClient; void core.validateSchema;\n")
  (target/'tsconfig.json').write_text(json.dumps({'compilerOptions':{'module':'NodeNext','moduleResolution':'NodeNext','target':'ES2022','strict':True,'noEmit':True,'skipLibCheck':False},'files':['consumer.mts','consumer.cts']}))
  subprocess.run(['node','node_modules/typescript/bin/tsc','--noEmit'],cwd=target,check=True)
 elif mode=='admin':
  (target/'runtime.mjs').write_text("import assert from 'node:assert/strict';\nimport { contentFnAdminCapability } from '@contentfn/admin';\nassert.equal(contentFnAdminCapability.availability,'folded');assert.equal(contentFnAdminCapability.owner.moduleId,'cmsfn');console.log('Packed admin passed',process.version);\n")
 else:
  (target/'runtime.mjs').write_text("import assert from 'node:assert/strict';\nimport { createRequire } from 'node:module';\nimport * as core from '@contentfn/core';import * as client from '@contentfn/client';\nconst require=createRequire(import.meta.url);assert.equal(typeof core.validateSchema,'function');assert.equal(typeof client.createContentfnClient,'function');assert.equal(typeof require('@contentfn/core').validateSchema,'function');assert.equal(typeof require('@contentfn/client').createContentfnClient,'function');console.log('Packed core/client passed',process.version);\n")
  subprocess.run(['npx','--yes','--package=node@18.18.0','node','node_modules/@contentfn/cli/dist/index.js','--version'],cwd=target,check=True)
 subprocess.run(['npx','--yes','--package=node@'+('18.18.0' if mode=='node18' else '20.19.0'),'node','runtime.mjs'],cwd=target,check=True)
 print(mode+' installed, audited and validated',flush=True)
print('All isolated packed consumers passed: '+str(out),flush=True)
