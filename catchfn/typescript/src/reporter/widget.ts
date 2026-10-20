import { parseBugIssueStatus } from "@watchfn/browser";
import html2canvas from "html2canvas";
import { CatchFnDeliveryError } from "../core/delivery-error.js";
import { Drawfn, type Scene, type ToolName } from "drawfn";
import type { CatchFn } from "../core/catch-fn.js";
import type { CatchFnConfig, AttachmentReference, BugSeverity } from "../core/types.js";

const MASK = "[data-catchfn-mask],input[type=password],input[autocomplete^=cc-],input[name*=card i],input[name*=cvv i]";
const id = () => `capture_${Date.now()}_${Math.random().toString(36).slice(2)}`;
function asDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read screenshot"));
    reader.readAsDataURL(blob);
  });
}

export class ReporterWidget {
  private root?: HTMLDivElement;
  private draw?: Drawfn;
  private screenshot?: HTMLCanvasElement;
  private screenshotId = id();
  private closed = false;
  private statusPoll?: AbortController;
  private previousFocus: Element | null = null;
  private blurMode = false;
  private drag?: {x:number;y:number};
  get isOpen(): boolean { return Boolean(this.root?.isConnected); }
  constructor(private catcher: CatchFn, private options: CatchFnConfig["reporter"] = {}) {}

  async open(): Promise<void> {
    this.previousFocus = document.activeElement;
    let screenshotFailed = false;
    if (this.options?.screenshot !== false) {
      try {
        const captured = await html2canvas(document.documentElement, {
          width:window.innerWidth, height:window.innerHeight, x:window.scrollX, y:window.scrollY,
          scale:1, useCORS:true, allowTaint:false, logging:false,
          ignoreElements:element=>element.hasAttribute("data-catchfn-ignore"),
          onclone:clone => {
            const selector = [MASK,...(this.options?.maskSelectors ?? [])].join(",");
            for (const element of clone.querySelectorAll<HTMLElement>(selector)) {
              const bounds = element.getBoundingClientRect();
              element.style.cssText += `;width:${bounds.width}px;height:${bounds.height}px;background:#111!important;color:transparent!important;overflow:hidden;`;
              element.textContent = "";
              if ("value" in element) (element as HTMLInputElement).value = "";
              if ("placeholder" in element) (element as HTMLInputElement).placeholder = "";
            }
          },
        });
        const width = Math.max(1, Math.min(captured.width, 640, window.innerWidth - 64));
        this.screenshot = document.createElement("canvas");
        this.screenshot.width = width;
        this.screenshot.height = Math.max(1, Math.round(captured.height * width / captured.width));
        this.screenshot.getContext("2d")!.drawImage(captured,0,0,this.screenshot.width,this.screenshot.height);
      } catch { screenshotFailed = true; }
    }
    if (this.closed) return;
    const root = document.createElement("div");
    this.root = root;
    root.className = "catchfn-overlay";
    root.setAttribute("data-catchfn-ignore", "");
    root.innerHTML = `<style>
.catchfn-overlay{position:fixed;inset:0;background:#0008;z-index:2147483647;display:flex;align-items:center;justify-content:center;font:14px system-ui;color:#17202a}.catchfn-dialog{background:white;border-radius:12px;padding:20px;max-width:calc(100vw - 32px);width:680px;max-height:90vh;overflow:auto;box-sizing:border-box}.catchfn-dialog h2{margin:0 0 16px}.catchfn-dialog label{display:block;margin:10px 0}.catchfn-dialog input:not([type=checkbox]),.catchfn-dialog textarea,.catchfn-dialog select{box-sizing:border-box;width:100%;padding:8px;border:1px solid #8b949e;border-radius:4px;font:inherit}.catchfn-dialog button{font:inherit;padding:8px 12px;margin:4px 4px 4px 0;cursor:pointer}.catchfn-dialog canvas{display:block;touch-action:none;border:1px solid #bbb}.catchfn-toolbar{display:flex;flex-wrap:wrap}.catchfn-status{min-height:20px}.catchfn-dialog :focus-visible{outline:3px solid #2867d8;outline-offset:2px}@media(prefers-reduced-motion:reduce){.catchfn-overlay *{transition:none!important;animation:none!important}}
</style><section class="catchfn-dialog" role="dialog" aria-modal="true" aria-labelledby="catchfn-heading"><h2 id="catchfn-heading">Report a bug</h2><form><label>Title<input name="title" required maxlength="2000"></label><label>Description<textarea name="description" rows="3"></textarea></label><label>Steps to reproduce<textarea name="steps" rows="3" placeholder="One step per line"></textarea></label><label>Severity<select name="severity"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option><option value="critical">Critical</option></select></label><label>Tags<input name="tags" placeholder="Separate tags with commas"></label><label><input type="checkbox" name="console" checked> Include console logs</label><label><input type="checkbox" name="network" checked> Include network summary</label><div class="catchfn-preview"></div><p class="catchfn-status" role="status" aria-live="polite"></p><button type="submit">Submit report</button><button type="button" data-close>Cancel</button></form></section>`;
    document.body.append(root);
    const form = root.querySelector("form")!;
    const status = root.querySelector<HTMLElement>(".catchfn-status")!;
    if (screenshotFailed) status.textContent = "Screenshot unavailable. You can still submit the report.";
    root.querySelector("[data-close]")!.addEventListener("click",()=>this.close());
    root.addEventListener("keydown",event=>{
      if (event.key === "Escape") { event.preventDefault(); this.close(); return; }
      if (event.key !== "Tab") return;
      const focusable = [...root.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex='0']")];
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {event.preventDefault();last?.focus();}
      else if (!event.shiftKey && document.activeElement === last) {event.preventDefault();first?.focus();}
    });
    if (this.screenshot) this.setupAnnotation(root.querySelector<HTMLElement>(".catchfn-preview")!);
    let pendingDelivery: CatchFnDeliveryError | undefined;
    form.addEventListener("submit",event=>{
      event.preventDefault();
      const submit = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
      if (submit.disabled) return;
      submit.disabled = true;
      status.textContent = "Submitting report…";
      void (async()=>{
        const capture = async () => {
        const data = new FormData(form);
        const attachments: AttachmentReference[] = [];
        if (this.draw && form.querySelector<HTMLInputElement>("[name=screenshot]")?.checked) {
          const blob = await this.draw.exportPNG({padding:0,scale:1});
          const scene = this.draw.getScene();
          // Do not retain hidden originals or duplicate screenshot pixels in scene metadata.
          scene.elements = scene.elements.filter(element=>element.id !== this.screenshotId);
          attachments.push({id:id(),name:"screenshot.png",type:"image/png",mimeType:"image/png",kind:"screenshot",size:blob.size,dataUrl:await asDataUrl(blob),annotationScene:scene});
        }
        return this.catcher.captureBug({title:String(data.get("title") ?? ""),description:String(data.get("description") ?? ""),steps:String(data.get("steps") ?? "").split("\n").map(value=>value.trim()).filter(Boolean),severity:String(data.get("severity")) as BugSeverity,tags:String(data.get("tags") ?? "").split(",").map(value=>value.trim()).filter(Boolean),includeConsoleLogs:data.has("console"),includeNetworkLogs:data.has("network"),attachments});
        };
        const report = pendingDelivery ? await pendingDelivery.retry() : await capture();
        pendingDelivery = undefined;
        if (this.closed) return;
        status.textContent = report.delivery === "sent" ? "Report submitted." : report.delivery === "dropped" ? "Report excluded by application settings; it has not been sent." : "Report captured locally; it has not been sent.";
        let linked = false;
        const showLink = (value: { target?: string; issueId?: string | null; issueUrl?: string | null }) => {
          try {
            const target = value.target ?? (new URL(value.issueUrl!).hostname === "github.com" ? "github" : "linear");
            const result = parseBugIssueStatus({ app: this.catcher.getConfig().name, reportId: report.id, state: "linked", target, issueId: value.issueId, issueUrl: value.issueUrl }, { app: this.catcher.getConfig().name, reportId: report.id });
            if (this.closed) return;
            status.textContent = "Report submitted.";
            const link = document.createElement("a"); link.href = result.issueUrl!; link.textContent = "View issue"; link.target = "_blank"; link.rel = "noopener noreferrer"; status.append(" ", link); linked = true;
          } catch { /* An accepted report must not become a preparation failure for a bad receipt. */ }
        };
        if (report.delivery === "sent" && report.integration?.issueUrl) showLink(report.integration);
        if (report.delivery === "sent" && !linked && this.catcher.getConfig().issueStatus?.enabled) {
          this.statusPoll?.abort(); const polling = new AbortController(); this.statusPoll = polling;
          status.textContent = "Report submitted. Waiting for the issue link…";
          // Observe status separately: failure must never offer report resubmission.
          void this.catcher.pollIssueStatus(report.id, { signal: polling.signal }).then(result => {
            if (this.closed || polling.signal.aborted || this.statusPoll !== polling) return;
            if (result?.state === "linked") showLink(result);
            else status.textContent = result?.state === "reconciliation" ? "Report submitted. Issue delivery needs operator attention." : "Report submitted. The issue link is not available yet.";
          }, () => {
            if (!this.closed && !polling.signal.aborted && this.statusPoll === polling) status.textContent = "Report submitted. Issue status is currently unavailable.";
          });
        }
        form.querySelector<HTMLButtonElement>("[data-close]")!.textContent="Close";
      })().catch(error=>{if (!this.closed) {
        if (error instanceof CatchFnDeliveryError) {
          pendingDelivery = error;
          status.textContent = "Delivery is unconfirmed. Retry sends the same report. Its details are locked; starting a new report creates another report and the queued original may still be delivered.";
          submit.textContent = "Retry same report";
          for (const field of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,textarea,select,.catchfn-toolbar button")) field.disabled = true;
          for (const canvas of form.querySelectorAll<HTMLCanvasElement>("canvas")) canvas.style.pointerEvents = "none";
          if (!form.querySelector("[data-new-report]")) {
            const fresh = document.createElement("button"); fresh.type = "button"; fresh.dataset.newReport = ""; fresh.textContent = "Start a new report";
            fresh.onclick = () => { this.close(); void this.catcher.openReporter().catch(()=>console.error("Could not open bug reporter")); };
            form.append(fresh);
          }
        } else status.textContent="Could not prepare the report. Check the fields or remove the screenshot if it is too large.";
        submit.disabled=false;
      }});
    });
    this.focus();
  }

  private setupAnnotation(preview: HTMLElement): void {
    const screenshot = this.screenshot!;
    const checkbox = document.createElement("label");
    checkbox.innerHTML = '<input type="checkbox" name="screenshot" checked> Include screenshot';
    preview.append(checkbox);
    const toolbar = document.createElement("div");toolbar.className="catchfn-toolbar";toolbar.setAttribute("role","toolbar");toolbar.setAttribute("aria-label","Screenshot annotation");preview.append(toolbar);
    const canvas = document.createElement("canvas");canvas.width=screenshot.width;canvas.height=screenshot.height;canvas.style.width=`${canvas.width}px`;canvas.style.height=`${canvas.height}px`;canvas.tabIndex=0;canvas.setAttribute("aria-label","Screenshot annotation canvas");preview.append(canvas);
    this.draw = new Drawfn({canvas,overlayRoot:preview});
    const scene: Scene = {version:1,id:id(),camera:{x:0,y:0,zoom:1},background:{color:"#fff"},elements:[{id:this.screenshotId,type:"image",x:0,y:0,w:screenshot.width,h:screenshot.height,rotation:0,stroke:"transparent",fill:"transparent",strokeWidth:0,opacity:1,locked:true,src:screenshot.toDataURL("image/png")} ]};
    const loaded = this.draw.loadScene(scene);if (!loaded.ok) throw new Error("Screenshot annotation unavailable");
    for (const [label,tool] of [["Select","select"],["Arrow","arrow"],["Box","rectangle"],["Text","text"],["Blur","blur"]] as const) {
      const button=document.createElement("button");button.type="button";button.textContent=label;button.onclick=()=>{this.blurMode=tool==="blur";this.draw!.setTool((tool==="blur"?"select":tool) as ToolName);};toolbar.append(button);
    }
    canvas.addEventListener("pointerdown",event=>{if(!this.blurMode)return;event.preventDefault();event.stopImmediatePropagation();const bounds=canvas.getBoundingClientRect();this.drag={x:event.clientX-bounds.left,y:event.clientY-bounds.top};canvas.setPointerCapture(event.pointerId);},true);
    canvas.addEventListener("pointermove",event=>{if(this.blurMode){event.preventDefault();event.stopImmediatePropagation();}},true);
    canvas.addEventListener("pointerup",event=>{
      if(!this.blurMode||!this.drag)return;event.preventDefault();event.stopImmediatePropagation();const bounds=canvas.getBoundingClientRect();const end={x:event.clientX-bounds.left,y:event.clientY-bounds.top};
      const x=Math.max(0,Math.floor(Math.min(this.drag.x,end.x))),y=Math.max(0,Math.floor(Math.min(this.drag.y,end.y)));const w=Math.min(screenshot.width-x,Math.ceil(Math.abs(end.x-this.drag.x))),h=Math.min(screenshot.height-y,Math.ceil(Math.abs(end.y-this.drag.y)));this.drag=undefined;
      if(w<1||h<1)return;
      const context=screenshot.getContext("2d")!;const pixels=context.getImageData(x,y,w,h);const source=new Uint8ClampedArray(pixels.data);
      for (let channel=0;channel<3;channel++) {
        const stride=w+1,sum=new Float64Array((w+1)*(h+1));
        for(let row=1;row<=h;row++) { let rowSum=0;for(let column=1;column<=w;column++){rowSum+=source[((row-1)*w+column-1)*4+channel];sum[row*stride+column]=sum[(row-1)*stride+column]+rowSum;} }
        for(let row=0;row<h;row++)for(let column=0;column<w;column++) {
          const top=Math.max(0,row-8),bottom=Math.min(h,row+9),left=Math.max(0,column-8),right=Math.min(w,column+9);
          const total=sum[bottom*stride+right]-sum[top*stride+right]-sum[bottom*stride+left]+sum[top*stride+left];
          pixels.data[(row*w+column)*4+channel]=total/((bottom-top)*(right-left));
        }
      }
      context.putImageData(pixels,x,y);this.draw!.update(this.screenshotId,{src:screenshot.toDataURL("image/png")});
    },true);
  }
  focus(): void { this.root?.querySelector<HTMLInputElement>("input[name=title]")?.focus(); }
  close(): void { this.closed=true;this.statusPoll?.abort();this.statusPoll=undefined;this.draw?.destroy();this.draw=undefined;this.root?.remove();this.root=undefined;if(this.previousFocus instanceof HTMLElement&&this.previousFocus.isConnected)this.previousFocus.focus(); }
}
