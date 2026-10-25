import pathlib, subprocess, json, tempfile, shutil, argparse, os
parser = argparse.ArgumentParser(description='Install the complete built Studio and run native browser acceptance')
parser.add_argument('--producer-root', type=pathlib.Path, help='Checkout containing the built matching ContentFn server')
parser.add_argument('--native-safari', action='store_true', help='Use installed Safari WebDriver; host automation must already be enabled')
parser.add_argument('--operational-only', action='store_true', help='Run installed operational JS boundaries and declaration/SSR checks without launching a browser')
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[2]
producer = (args.producer_root or root).resolve()
out=pathlib.Path(tempfile.mkdtemp(prefix='cms-studio-packed-',dir='/tmp'));print(out,flush=True)
packages={}
for path in subprocess.check_output(['rg','--files','-g','package.json'],cwd=root,text=True).splitlines():
 p=root/path
 try:
  m=json.loads(p.read_text())
  if 'name' in m:packages[m['name']]=(p.parent,m)
 except ValueError:pass
p=producer/'contentfn/server/package.json';packages['@contentfn/server']=(p.parent,json.loads(p.read_text()))
selected={}
def add(name):
 if name in selected or name not in packages:return
 selected[name]=packages[name]
 for dependency in packages[name][1].get('dependencies',{}):add(dependency)
for name in ['@cmsfn/studio','@cmsfn/server','@contentfn/server','@superfunctions/db']:add(name)
deps={}
for name,(path,m) in selected.items():
 packed=json.loads(subprocess.check_output(['npm','pack','--ignore-scripts','--json','--pack-destination',str(out)],cwd=path,text=True))
 deps[name]='file:'+str(out/packed[0]['filename'])
print('Local closure:',list(deps),flush=True)
(out/'package.json').write_text(json.dumps({'private':True,'type':'module','dependencies':deps,'overrides':{k:'$'+k for k in deps}}))
subprocess.run(['npx','--yes','npm@11','install'],cwd=out,check=True)
with (out / 'production-audit.json').open('w') as f:subprocess.run(['npx','--yes','npm@11','audit','--omit=dev','--json'],cwd=out,stdout=f)
subprocess.run(['npx','--yes','npm@11','install','--save-dev','esbuild@0.25.12','playwright@1.57.0','typescript@5.9.3','@types/react@18','@types/react-dom@18','@types/node@22'],cwd=out,check=True)
shutil.copy(root/'cmsfn/.conduct/studio-browser-acceptance.mjs',out/'acceptance.mjs')
shutil.copy(root/'cmsfn/.conduct/studio-safari-acceptance.mjs',out/'studio-safari-acceptance.mjs')
shutil.copy(root/'cmsfn/.conduct/operational-logging-package.mjs', out/'operational-logging-package.mjs')
subprocess.run(['node','operational-logging-package.mjs'],cwd=out,check=True)
if not args.operational_only:
 subprocess.run(['node','acceptance.mjs'],cwd=out,check=True,env={**os.environ, **({'CMSFN_NATIVE_SAFARI':'1'} if args.native_safari else {})})
(out / 'consumer.tsx').write_text("""import { App, boot, type CmsfnStudioConfig } from '@cmsfn/studio';
import * as React from 'react';
import { parseReferenceInput, type CmsfnReferenceInput, type CmsfnReferencePage } from 'cmsfn';
const referenceInput: CmsfnReferenceInput = { dataset: 'prod', types: ['author'], limit: 20 };
const parsed = parseReferenceInput(referenceInput);
const emptyReferences: CmsfnReferencePage = { dataset: 'prod', data: [], nextCursor: null };
void parsed; void emptyReferences;
import {createCmsfnServer, verifyPreviewToken, type PreviewTokenClaims} from '@cmsfn/server';
const claims: PreviewTokenClaims | null = verifyPreviewToken('server-only-secret-material', 'untrusted-token', { audience: 'https://preview.example', dataset: 'prod', docId: 'post' });
void claims;
const config: CmsfnStudioConfig = { contentfn: { baseUrl: 'http://localhost' }, datasets: [{ name: 'prod' }], auth: { kind: 'custom' }, desk: { kind: 'divider' } };
const element: React.ReactElement = <App config={config} />;
boot(config);
const server = createCmsfnServer(config);
void server.readiness.then(result => { if (result.ok) result.result.capabilities.map(value => value.toUpperCase()); });
const runDue: () => Promise<import("@cmsfn/server").DueReleaseResult> = () => server.executeDueReleases({ limit: 2, maxDocuments: 5 });
void runDue;
server.reportSessionEvent('session.login', { subject: 'verified-host-actor', succeeded: true });
const loggingFailures: number = server.loggingStatus().failures;
void loggingFailures;
""")
(out / 'consumer.cts').write_text("""import { App, boot } from '@cmsfn/studio';
import { createElement } from 'react';
createElement(App);
boot({ contentfn: { baseUrl: 'http://localhost' }, datasets: [{ name: 'prod' }], auth: { kind: 'custom' }, desk: { kind: 'divider' } });
""")
subprocess.run(['node', 'node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--jsx', 'react-jsx', '--target', 'ES2022', 'consumer.tsx', 'consumer.cts'], cwd=out, check=True)
for extension, imports in [('mjs', "import {App} from '@cmsfn/studio'; import {createElement} from 'react'; import {renderToStaticMarkup} from 'react-dom/server';"), ('cjs', "const {App}=require('@cmsfn/studio'); const {createElement}=require('react'); const {renderToStaticMarkup}=require('react-dom/server');")]:
    script = out / ('exports.' + extension)
    script.write_text(imports + "if(!renderToStaticMarkup(createElement(App)).includes('no-config')) throw Error('SSR export failed');")
    subprocess.run(['node', str(script)], cwd=out, check=True)
print('Acceptance completed. Retained disposable consumer for inspection:', out, flush=True)
