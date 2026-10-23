"""Normal isolated production install and actual HTTP publish replay acceptance."""
import json, pathlib, subprocess, tempfile, shutil
root = pathlib.Path(__file__).resolve().parents[2]
out = pathlib.Path(tempfile.mkdtemp(prefix='contentfn-publish-packed-'))
print(out, flush=True)
packages = {}
for path in ['packages/db','packages/http','packages/storage','mdfn/core','mdfn/markdown','mdfn/extensions','mdfn/contentfn','contentfn/core','contentfn/server']:
    manifest = json.loads((root/path/'package.json').read_text())
    packed = json.loads(subprocess.check_output(['npm','pack','--ignore-scripts','--json','--pack-destination',str(out)],cwd=root/path,text=True))
    packages[manifest['name']] = 'file:' + str(out/packed[0]['filename'])
(out/'package.json').write_text(json.dumps({'private':True,'type':'module','dependencies':packages}))
subprocess.run(['npx','--yes','npm@11','install'],cwd=out,check=True)
with (out/'production-audit.json').open('w') as f:
    subprocess.run(['npx','--yes','npm@11','audit','--omit=dev','--json'],cwd=out,stdout=f,check=True)
shutil.copyfile(root/'contentfn/.conduct/publish-idempotency-packed.mjs',out/'acceptance.mjs')
subprocess.run(['node','acceptance.mjs'],cwd=out,check=True)
