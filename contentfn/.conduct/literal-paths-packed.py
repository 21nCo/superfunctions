"""Fresh normal core/server/client package installation for literal patch compatibility."""
import json, os, pathlib, shutil, subprocess, tempfile
root = pathlib.Path(__file__).resolve().parents[2]
out = pathlib.Path(tempfile.mkdtemp(prefix='content-literal-packed-'))
try:
    paths = ['packages/observability','packages/db','packages/http','packages/storage','mdfn/core','mdfn/markdown','mdfn/extensions','mdfn/contentfn','contentfn/core','contentfn/client','contentfn/server','contentfn/cli']
    deps = {}
    for path in paths:
        manifest = json.loads((root/path/'package.json').read_text())
        packed = json.loads(subprocess.check_output(['npm','pack','--ignore-scripts','--json','--pack-destination',str(out)],cwd=root/path,text=True))
        deps[manifest['name']] = 'file:'+str(out/packed[0]['filename'])
    (out/'package.json').write_text(json.dumps({'private':True,'type':'module','dependencies':deps,'devDependencies':{'typescript':'5.9.3','@types/node':'22.19.0'}}))
    npm = ['node', os.environ['CONTENTFN_NPM_CLI']]
    subprocess.run(npm+['install','--no-fund'],cwd=out,check=True)
    shutil.copy2(root/'contentfn/.conduct/packed-runtime.mjs',out/'runtime.mjs')
    subprocess.run(['node','runtime.mjs'],cwd=out,check=True)
    (out/'consumer.mts').write_text("import { createContentfnClient } from '@contentfn/client'; import type { ContentfnPatchPath } from '@contentfn/core'; const path: ContentfnPatchPath = ['literal.key']; void createContentfnClient({baseUrl:'http://localhost'}).docs.patch({dataset:'prod',id:'one',ops:[{op:'set',path,value:'saved'},{op:'unset',path:'section.title'}]});")
    subprocess.run(['node','node_modules/typescript/bin/tsc','--strict','--noEmit','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2022','consumer.mts'],cwd=out,check=True)
    audit = subprocess.run(npm+['audit','--omit=dev','--json'],cwd=out,text=True,capture_output=True)
    report=json.loads(audit.stdout); print(json.dumps(report['metadata']['vulnerabilities']),flush=True)
    assert report['metadata']['vulnerabilities']['total']==0
    print('12 packed packages: actual HTTP/client/CLI, ESM/CJS, strict types and production audit passed',flush=True)
finally:
    shutil.rmtree(out)
    print('Owned consumer removed:',not out.exists(),flush=True)
