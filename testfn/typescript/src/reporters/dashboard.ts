import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestStorage } from "../storage/test-storage.js";
import type { Screenshot } from "../types.js";
import { comparisonHtml } from "../visual/images.js";

export interface DashboardOptions {
  limit?: number;
  comparisons?: Array<{
    name: string;
    baseline: Screenshot;
    current: Screenshot;
  }>;
}
/** Writes an offline dashboard. Storage lifecycle remains owned by the caller. */
export async function generateDashboard(
  storage: TestStorage,
  directory: string,
  options: DashboardOptions = {},
): Promise<void> {
  const runs = await storage.getRecentRuns(options.limit ?? 100);
  await mkdir(join(directory, "data"), { recursive: true });
  await writeFile(join(directory, "data", "runs.json"), JSON.stringify(runs));
  const viewers = (options.comparisons ?? []).map((item) => ({
    name: item.name,
    html: comparisonHtml(item.name, item.baseline, item.current),
  }));
  const data = JSON.stringify({ runs, viewers }).replace(/</g, "\\u003c");
  for (const [file, page] of [
    ["index.html", "Overview"],
    ["test.html", "Test details"],
    ["visual.html", "Visual diffs"],
    ["analytics.html", "Analytics"],
  ]) {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TestFn ${page}</title><style>
body{font:16px system-ui;margin:0;background:#f4f6fa;color:#182336}main{max-width:1100px;margin:auto;padding:24px}nav{display:flex;gap:20px;flex-wrap:wrap}a{color:#2458a6}section{background:white;padding:20px;margin:20px 0;border-radius:10px}table{border-collapse:collapse;width:100%;display:block;overflow:auto}th,td{text-align:left;padding:10px;border-bottom:1px solid #ddd}button,select{font:inherit;padding:8px}svg{width:100%;height:180px}iframe{width:100%;height:650px;border:0}pre{white-space:pre-wrap;overflow-wrap:anywhere}.cards{display:flex;gap:24px;flex-wrap:wrap}
</style></head><body><main><nav><a href="index.html">Overview</a><a href="test.html">Test details</a><a href="visual.html">Visual diffs</a><a href="analytics.html">Analytics</a></nav><h1>${page}</h1><div id="app"></div></main><script id="data" type="application/json">${data}</script><script>
const {runs,viewers}=JSON.parse(document.getElementById('data').textContent);const page=${JSON.stringify(page)};const app=document.getElementById('app');
const element=(tag,text,parent=app)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;parent.append(el);return el;};
const section=title=>{const s=element('section');element('h2',title,s);return s;};
const table=(headers,rows,parent)=>{const t=element('table',undefined,parent),head=element('tr',undefined,t);headers.forEach(h=>element('th',h,head));rows.forEach(row=>{const tr=element('tr',undefined,t);row.forEach(value=>element('td',String(value??''),tr));});};
const history=new Map();for(const run of runs)for(const result of run.results){const list=history.get(result.id)??[];list.push({...result,timestamp:run.timestamp,runId:run.id});history.set(result.id,list);}
const chart=(values,parent)=>{const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 800 180');svg.setAttribute('role','img');svg.setAttribute('aria-label','Duration trend');const line=document.createElementNS(svg.namespaceURI,'polyline');const max=Math.max(1,...values);line.setAttribute('points',values.map((v,i)=>((i/(Math.max(values.length-1,1)))*780+10)+','+(170-v/max*150)).join(' '));line.setAttribute('fill','none');line.setAttribute('stroke','#2458a6');line.setAttribute('stroke-width','3');svg.append(line);parent.append(svg);};
if(page==='Overview'){
 const s=section('Recent runs');table(['Run','Time','Passed','Failed','Skipped','Duration ms'],runs.map(r=>[r.id,new Date(r.timestamp).toISOString(),r.summary.passed,r.summary.failed,r.summary.skipped,r.summary.duration]),s);
 chart([...runs].reverse().map(r=>r.summary.duration),section('Run duration trend'));
 const flaky=[...history].filter(([,items])=>items.some(r=>r.status==='passed')&&items.some(r=>r.status==='failed'||r.status==='timeout'));table(['Test','Passes','Failures'],flaky.map(([id,items])=>[id,items.filter(r=>r.status==='passed').length,items.filter(r=>r.status==='failed'||r.status==='timeout').length]),section('Flaky tests'));
}else if(page==='Test details'){
 const selector=element('select');selector.setAttribute('aria-label','Test');for(const id of history.keys()){const option=element('option',id,selector);option.value=id;}const details=section('History');const show=()=>{details.replaceChildren();const items=history.get(selector.value)??[];element('h2',selector.value,details);table(['Run','Time','Status','Duration ms','Error'],items.map(r=>[r.runId,new Date(r.timestamp).toISOString(),r.status,r.duration,r.error?.message??'']),details);chart([...items].reverse().map(r=>r.duration),details);};selector.addEventListener('change',show);show();
}else if(page==='Analytics'){
 chart([...runs].reverse().map(r=>r.summary.duration),section('Performance trend'));const failures=new Map();for(const r of runs)for(const t of r.results)if(t.error)failures.set(t.error.message,(failures.get(t.error.message)??0)+1);table(['Failure','Count'],[...failures].sort((a,b)=>b[1]-a[1]),section('Failure analysis'));table(['Run','Lines %','Statements %','Functions %','Branches %'],runs.filter(r=>r.summary.coverage).map(r=>[r.id,r.summary.coverage.lines,r.summary.coverage.statements,r.summary.coverage.functions,r.summary.coverage.branches]),section('Coverage history'));
}else{
 if(!viewers.length)element('p','No visual comparisons supplied.');for(const viewer of viewers){const s=section(viewer.name),frame=element('iframe',undefined,s);frame.title=viewer.name;frame.setAttribute('sandbox','allow-scripts');frame.srcdoc=viewer.html;}
}
</script></body></html>`;
    await writeFile(join(directory, file), html);
  }
}
