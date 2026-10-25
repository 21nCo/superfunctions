export type CheckType = 'http' | 'browser';
export interface Assertion {
  type: 'status' | 'responseTime' | 'body' | 'header';
  operator: 'eq' | 'lt' | 'gt' | 'contains';
  value: string | number;
  key?: string;
}
export interface SyntheticCheck {
  id?: string;
  name: string;
  type: CheckType;
  url?: string;
  method?: string;
  headers?: Record<string,string>;
  interval: number | string;
  timeout?: number;
  retries?: number;
  maxResponseBytes?: number;
  assertions?: Assertion[];
  locations?: string[];
  alerts?: unknown;
}
export interface CheckResult {
  checkId: string;
  checkName?: string;
  runId?: string;
  startedAt?: number;
  timestamp: number;
  success: boolean;
  duration: number;
  attempts?: number;
  totalDuration?: number;
  error?: string;
  response?: {status?:number;headers?:Record<string,string>;bodySize?:number};
}
export function durationMilliseconds(value:number|string):number {
  const match=typeof value==='string' ? /^(\d+)(ms|s|m|h|d)$/.exec(value) : null;
  const ms=typeof value==='number' ? value : match ? Number(match[1])*({ms:1,s:1000,m:60000,h:3600000,d:86400000}[match[2]]!) : NaN;
  if(!Number.isSafeInteger(ms)||ms<10||ms>2147483647)throw new TypeError('Synthetic interval must be 10ms through 2147483647ms');
  return ms;
}
export function validateCheck(input:SyntheticCheck):SyntheticCheck & {interval:number;timeout:number;retries:number;maxResponseBytes:number} {
  if(!input||input.type!=='http')throw new TypeError('Synthetic browser execution is unavailable; only HTTP checks are supported');
  if(typeof input.name!=='string'||!input.name.trim()||input.name.length>256||(input.id!==undefined&&(typeof input.id!=='string'||!input.id||input.id.length>256)))throw new TypeError('Invalid synthetic identity');
  if(input.locations!==undefined || input.alerts!==undefined)throw new TypeError('Synthetic locations and consecutive-failure alerts are not implemented');
  if(typeof input.url!=='string'||Buffer.byteLength(input.url)>4096)throw new TypeError('Synthetic URL exceeds 4096 bytes');
  let url:URL;try{url=new URL(input.url!);}catch{throw new TypeError('Synthetic HTTP URL required');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new TypeError('Invalid synthetic HTTP URL');
  const method=input.method??'GET';if(!['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(method))throw new TypeError('Invalid synthetic HTTP method');
  const timeout=input.timeout??5000,retries=input.retries??0,maxResponseBytes=input.maxResponseBytes??1048576;
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>300000||!Number.isSafeInteger(retries)||retries<0||retries>5||!Number.isSafeInteger(maxResponseBytes)||maxResponseBytes<1||maxResponseBytes>16777216)throw new TypeError('Invalid synthetic timeout, retries or response limit');
  if(input.headers && (Object.keys(input.headers).length>100||Object.entries(input.headers).some(([k,v])=>typeof v!=='string'||k.length+v.length>8192)))throw new TypeError('Invalid synthetic headers');
  if(input.headers&&Object.entries(input.headers).reduce((total,[key,value])=>total+Buffer.byteLength(key)+Buffer.byteLength(value),0)>16384)throw new TypeError('Synthetic headers exceed 16KiB aggregate');
  new Headers(input.headers);
  if(input.assertions!==undefined && (!Array.isArray(input.assertions)||input.assertions.length>100))throw new TypeError('Invalid synthetic assertions');
  for(const a of input.assertions??[]){
    if(!a||!['status','responseTime','body','header'].includes(a.type)||!['eq','lt','gt','contains'].includes(a.operator))throw new TypeError('Invalid synthetic assertion');
    if(a.type==='status'||a.type==='responseTime'){
      if(typeof a.value!=='number'||!Number.isFinite(a.value)||a.operator==='contains')throw new TypeError('Invalid numeric synthetic assertion');
    }else if(typeof a.value!=='string'||a.value.length>16384||!['eq','contains'].includes(a.operator)||(a.type==='header'&&(typeof a.key!=='string'||!a.key)))throw new TypeError('Invalid textual synthetic assertion');
  }
  return structuredClone({...input,url:url.href,method,interval:durationMilliseconds(input.interval),timeout,retries,maxResponseBytes});
}
