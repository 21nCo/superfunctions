import pathlib,subprocess,json,tempfile
root=pathlib.Path(__file__).resolve().parents[1]
out=pathlib.Path(tempfile.mkdtemp(prefix='contentfn-packed-'))
print(out,flush=True)
paths=['packages/db','packages/http','packages/storage','mdfn/core','mdfn/markdown','mdfn/extensions','mdfn/contentfn','contentfn/core','contentfn/client','contentfn/server','contentfn/cli','mcpfn/core','packages/admin','contentfn/admin']
packages={}
for path in paths:
 manifest=json.loads((root/path/'package.json').read_text())
 result=subprocess.run(['npm','pack','--ignore-scripts','--json','--pack-destination',str(out)],cwd=root/path,check=True,capture_output=True,text=True)
 packages[manifest['name']]='file:'+str(out/json.loads(result.stdout)[0]['filename'])
for mode in ['core','admin']:
 target=out/mode;target.mkdir()
 deps={name:value for name,value in packages.items() if mode=='admin' or name not in ['@mcpfn/core','@superfunctions/admin','@contentfn/admin']}
 (target/'package.json').write_text(json.dumps({'private':True,'type':'module','dependencies':deps,'devDependencies':{'typescript':'5.9.3','@types/node':'22.19.0'}}))
 with (out/(mode+'-install.log')).open('w') as log:subprocess.run(['npx','--yes','npm@11.21.0','install','--ignore-scripts'],cwd=target,stdout=log,stderr=subprocess.STDOUT,check=True)
 with (out/(mode+'-audit.json')).open('w') as log:subprocess.run(['npm','audit','--omit=dev','--json'],cwd=target,stdout=log)
print('Consumers installed',flush=True)
(root/'_conduct/content-packed-path.txt').write_text(str(out))
