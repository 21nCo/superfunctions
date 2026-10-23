/** Installed browser SDK journal contract; never reads a user browser profile. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const directory = await mkdtemp(join(tmpdir(), 'userfn-journal-package-'));
const run = (command, args, cwd = directory, env = process.env) => execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const npm = (args, cwd) => process.env.USERFN_NPM_CLI ? run(process.execPath, [process.env.USERFN_NPM_CLI, ...args], cwd) : run('npm', args, cwd);
try {
  const tarballs = [];
  for (const folder of ['watchfn/agents/browser', 'userfn/typescript']) {
    const [pack] = JSON.parse(npm(['pack', '--json', '--pack-destination', directory], join(root, folder)));
    tarballs.push(join(directory, pack.filename));
  }
  await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  npm(['install', '--no-fund', ...tarballs, 'typescript@5.6.3', '@types/node@22']);
  for (const extension of ['mts', 'cts']) {
    await writeFile(join(directory, `consumer.${extension}`), `import {UserFnClient,type SurveyJournalOptions} from 'userfn'; const journal:SurveyJournalOptions={storageKey:'owned',storage:{getItem:()=>null,setItem:()=>{}}}; const client=new UserFnClient({apiKey:'key',endpoint:'https://example.test',surveyJournal:journal}); const opened:Promise<boolean>=client.openSurvey('survey'); void opened;`);
    run(process.execPath, ['node_modules/typescript/bin/tsc', '--strict', '--noEmit', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', `consumer.${extension}`]);
  }
  await writeFile(join(directory, 'runtime.mjs'), `import {UserFnClient} from 'userfn'; import {createRequire} from 'node:module'; for(const Client of [UserFnClient,createRequire(import.meta.url)('userfn').UserFnClient]) new Client({apiKey:'key',endpoint:'https://example.test',surveyJournal:{storageKey:'owned',storage:{getItem:()=>null,setItem:()=>{}}}});`);
  run(process.execPath, ['runtime.mjs']);
  process.stdout.write(run(process.execPath, [join(root, 'userfn/typescript/scripts/verify-survey-renderer.mjs')], root, { ...process.env, USERFN_SDK_ENTRY: join(directory, 'node_modules/userfn/dist/index.js') }));
  await writeFile(join(directory, 'board.mts'), `import {UserFnClient,type FeedbackBoardHandle} from 'userfn'; function mount(host:HTMLElement):FeedbackBoardHandle{return new UserFnClient({apiKey:'key'}).mountFeedbackBoard(host,{limit:10,status:'open'});} void mount;`);
  run(process.execPath, ['node_modules/typescript/bin/tsc', '--strict', '--noEmit', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', 'board.mts']);
  process.stdout.write(run(process.execPath, [join(root, 'userfn/typescript/scripts/verify-feedback-board.mjs')], root, { ...process.env, USERFN_SDK_ENTRY: join(directory, 'node_modules/userfn/dist/index.js') }));
  console.log(JSON.stringify({ installedPackages: tarballs.length, esmCjsTypesAndConstruction: true, installedBrowserJournal: true }));
} finally { await rm(directory, { recursive: true, force: true }); }
