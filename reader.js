import { randomBytes, createHash } from 'node:crypto';
import { createFold, epochMs, limitOption, safeError } from './fold.js';

// Cordis creates fresh caller-context proxies on service access. Unwrap for identity ONLY.
const originalSymbol=Symbol.for('cordis.original');
const canonicalIdentity=value=>value?.[originalSymbol]??value;
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
function checkAbort(signal) { if (signal?.aborted) throw safeError('ABORTED'); }
function parameters(input={}) {
 if (input===null || typeof input!=='object' || Array.isArray(input)) throw safeError('INVALID_QUERY');
 const timeZone=input.timeZone??'UTC';
 if (typeof timeZone!=='string'||timeZone.length>128||/^[+-]/u.test(timeZone)) throw safeError('INVALID_QUERY');
 let formatter;
 try { formatter=new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}); }
 catch { throw safeError('INVALID_QUERY'); }
 const fromMs=input.fromMs??null,toMs=input.toMs??null;
 if ((fromMs!==null && epochMs(fromMs)===null)||(toMs!==null && epochMs(toMs)===null)||(fromMs!==null&&toMs!==null&&fromMs>=toMs)) throw safeError('INVALID_QUERY');
 if (input.pinSessionId!==undefined && !validId(input.pinSessionId)) throw safeError('INVALID_QUERY');
 return {timeZone,fromMs,toMs,pinSessionId:input.pinSessionId??null,formatter};
}
function dayOf(time,formatter) {
 if (time===null) return null;
 const parts=formatter.formatToParts(time);
 return ['year','month','day'].map(type=>parts.find(part=>part.type===type).value).join('-');
}
function marked(metrics,truncated) {
 if (!truncated) return metrics;
 return {...metrics,coverage:'partial',cost:{...metrics.cost,complete:false}};
}
function rowFor(id,source,p,tools) {
 const filtered=p.fromMs!==null||p.toMs!==null;
 let excludedTimeCalls=0;
 const calls=source.calls.filter(call=>{
  if (call.timeMs===null && filtered) {excludedTimeCalls++;return false;}
  return (p.fromMs===null||call.timeMs>=p.fromMs)&&(p.toMs===null||call.timeMs<p.toMs);
 });
 const models=new Map(),days=new Map();
 for (const call of calls) {
  const key=JSON.stringify([call.provider,call.model]);
  if (!models.has(key)) models.set(key,{provider:call.provider,model:call.model,calls:[]});
  models.get(key).calls.push(call);
  const day=dayOf(call.timeMs,p.formatter);
  if (!days.has(day)) days.set(day,[]);
  days.get(day).push(call);
 }
 const summarize=items=>marked(tools.summarize(items),source.truncated||excludedTimeCalls>0);
 const last=calls.at(-1);
 return {sessionId:id,createdAtMs:source.createdAtMs,updatedAtMs:source.updatedAtMs,source:source.source,asOfSeq:source.asOfSeq,metrics:summarize(calls),last:last?{turn:last.turn,step:last.step,attempt:last.attempt,timeMs:last.timeMs,provider:last.provider,model:last.model,metrics:summarize([last])}:null,models:[...models.values()].map(group=>({provider:group.provider,model:group.model,metrics:summarize(group.calls)})),days:[...days].map(([day,items])=>({day,metrics:summarize(items)})),truncated:source.truncated,excludedTimeCalls};
}
function unavailable(id,tools) {
 return {sessionId:id,createdAtMs:null,updatedAtMs:null,source:'unavailable',asOfSeq:null,metrics:tools.emptyMetrics(),last:null,models:[],days:[],truncated:false,excludedTimeCalls:0};
}

// Header enumeration is native and UNPAGED. Only subsequent observation/folding is cohorted.
export function createReader(ctx,metricTools,options={}) {
 if (options===null || typeof options!=='object' || Array.isArray(options)) throw safeError('INVALID_QUERY');
 const pageSize=limitOption(options.pageSize,5,5),maxCalls=limitOption(options.maxCalls,5000,50000),maxEvents=limitOption(options.maxEvents,100000,1000000);
 const maxStreamRecords=limitOption(options.maxStreamRecords,100000,1000000);
 const capacity=limitOption(options.maxCachedSessions,20,100),snapshotCapacity=limitOption(options.maxSnapshots,8,64),snapshotLimit=limitOption(options.maxSnapshotSessions,20000,100000),ttl=limitOption(options.cursorTTLms,120000,3600000);
 const now=options.now??Date.now;
 if (typeof now!=='function') throw safeError('INVALID_QUERY');
 let disposed=false,identity,queryService,queryIdentity;
 const cache=new Map(),snapshots=new Map();
 function synchronize() {
  if (disposed) throw safeError('SOURCE_UNAVAILABLE');
  let next,nextService,nextQueryIdentity;
  try {
    next=canonicalIdentity((typeof ctx.get==='function'?ctx.get('sessionPersistence'):ctx.sessionPersistence)?.identity);
    nextService=ctx.sessionQuery;
    nextQueryIdentity=canonicalIdentity(nextService);
   }
  catch { throw safeError('SOURCE_UNAVAILABLE'); }
  if (identity!==next || queryIdentity!==nextQueryIdentity) {cache.clear();snapshots.clear();}
   identity=next;queryIdentity=nextQueryIdentity;
   // Methods must still run through the traced proxy so native Service sees this caller's context.
   queryService=nextService;
  if (!queryService || typeof queryService.observeSession!=='function' || typeof queryService.listSessions!=='function') throw safeError('SOURCE_UNAVAILABLE');
  for (const [key,value] of snapshots) if (value.expires<=now()) snapshots.delete(key);
 }
 async function read(id,p,signal) {
  if (disposed) throw safeError('SOURCE_UNAVAILABLE');
  checkAbort(signal);
  let observation;
  const previousQuery=queryService,previousQueryIdentity=queryIdentity,previousIdentity=identity;
  try {
   observation=await previousQuery.observeSession(id,{signal,projectionMode:'none'});
   checkAbort(signal);
   // Capture identity BEFORE awaiting: another request may synchronize a new profile meanwhile.
   synchronize();
   if (previousQueryIdentity!==queryIdentity||previousIdentity!==identity) throw safeError('STALE_CURSOR');
   const h=observation.header;
   if (h?.id!==id || !Array.isArray(observation.events)) throw safeError('SOURCE_UNAVAILABLE');
   const cursor=Number.isSafeInteger(observation.cursor)&&observation.cursor>=0?observation.cursor:null;
   const createdAtMs=epochMs(h.createdAt),updatedAtMs=epochMs(h.updatedAt);
   const source=observation.source==='live'?'live':'stored';
   const prior=cache.get(id);
   const revision=typeof observation.revision==='string' && observation.revision.length<=1024 ? createHash('sha256').update(observation.revision).digest('hex') : null;
   let folded;
   // Live generations may be replaced at the same cursor. Only prepared, revisioned observations reuse sanitized folds.
   if (source==='stored' && revision!==null && cursor!==null && prior && prior.cursor===cursor && prior.revision===revision && prior.source===source && prior.createdAtMs===createdAtMs && prior.updatedAtMs===updatedAtMs && prior.inherited===observation.inheritedEventCount) folded=prior.folded;
   else {
    const fold=createFold(metricTools,{inheritedEventCount:observation.inheritedEventCount,maxCalls,maxEvents,maxStreamRecords});
    const count=Math.min(observation.events.length,maxEvents);
    for (let index=0;index<count;index++) { if (index%256===0) checkAbort(signal); fold.push(observation.events[index]); }
    folded=fold.finish();
    if (observation.events.length>maxEvents) folded.truncated=true;
    checkAbort(signal);
    cache.delete(id);
    if (source==='stored' && revision!==null) cache.set(id,{cursor,revision,source,createdAtMs,updatedAtMs,inherited:observation.inheritedEventCount,folded});
    while(cache.size>capacity) cache.delete(cache.keys().next().value);
   }
   return rowFor(id,{...folded,source,createdAtMs,updatedAtMs,asOfSeq:cursor},p,metricTools);
  } catch(error) {
   checkAbort(signal);
   if (disposed) throw safeError('SOURCE_UNAVAILABLE');
   if (error?.code==='STALE_CURSOR') throw safeError('STALE_CURSOR');
   return unavailable(id,metricTools);
  } finally {
   if (observation) {
    try { observation[Symbol.dispose]?.(); }
    catch { /* A native disposer error must never expose upstream text. */ }
   }
  }
 }
 return {
  async session(input,signal) {
   const p=parameters(input);
   if (!validId(input?.sessionId)) throw safeError('INVALID_QUERY');
   synchronize();checkAbort(signal);
   return read(input.sessionId,p,signal);
  },
  async query(input={},signal) {
   const p=parameters(input),binding=JSON.stringify([p.fromMs,p.toMs,p.timeZone,p.pinSessionId]);
   synchronize();checkAbort(signal);
   const pageQueryIdentity=queryIdentity,pageIdentity=identity;
   let state;
   if (input.cursor!==undefined && input.cursor!==null) {
    if (typeof input.cursor!=='string'||input.cursor.length>128) throw safeError('INVALID_QUERY');
    state=snapshots.get(input.cursor);
    if (!state) throw safeError('STALE_CURSOR');
    if (state.binding!==binding) throw safeError('INVALID_QUERY');
   } else {
    let listed;
    const previousQuery=queryService,previousQueryIdentity=queryIdentity,previousIdentity=identity;
    try { listed=await previousQuery.listSessions(signal); }
    catch {checkAbort(signal);throw safeError('SOURCE_UNAVAILABLE');}
    checkAbort(signal);synchronize();
    if (previousQueryIdentity!==queryIdentity||previousIdentity!==identity) throw safeError('STALE_CURSOR');
    if (!Array.isArray(listed)||listed.length>snapshotLimit) throw safeError('SOURCE_UNAVAILABLE');
    const ids=[];const seen=new Set();
    for (const item of listed) { const id=item?.header?.id;if (!validId(id)) throw safeError('SOURCE_UNAVAILABLE');if(!seen.has(id)){seen.add(id);ids.push(id);} }
    if (p.pinSessionId && seen.has(p.pinSessionId)) {ids.splice(ids.indexOf(p.pinSessionId),1);ids.unshift(p.pinSessionId);}
    state={ids,index:0,skipped:0,binding,expires:now()+ttl};
   }
   // Input cursors are immutable positions, so aborted calls/retries cannot drop a cohort.
   const rows=[];let skipped=state.skipped;
   const end=Math.min(state.index+pageSize,state.ids.length);
   for(let index=state.index;index<end;index++) {checkAbort(signal);const row=await read(state.ids[index],p,signal);rows.push(row);if(row.source==='unavailable')skipped++;}
   checkAbort(signal);synchronize();
   if (pageQueryIdentity!==queryIdentity || pageIdentity!==identity || state.expires<=now()) throw safeError('STALE_CURSOR');
   let nextCursor=null;
   if (end<state.ids.length) {
    nextCursor=randomBytes(24).toString('base64url');
    snapshots.set(nextCursor,{...state,index:end,skipped});
    while(snapshots.size>snapshotCapacity) snapshots.delete(snapshots.keys().next().value);
   }
   return {rows,nextCursor,totalSessions:state.ids.length,scannedSessions:end,skippedSessions:skipped,complete:end===state.ids.length,timeZone:p.timeZone,fromMs:p.fromMs,toMs:p.toMs};
  },
  dispose() {disposed=true;cache.clear();snapshots.clear();identity=undefined;queryService=undefined;queryIdentity=undefined;}
 };
}
