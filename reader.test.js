import test from 'node:test';
import assert from 'node:assert/strict';
import { createReader } from './reader.js';
import { createMetricTools } from './metrics.js';
const blank=()=>({observedCalls:0,missingCalls:0,invalidCalls:0,coverage:'unavailable',tokens:{uncachedInputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null,reasoningTokens:null,totalTokens:null},cost:{mode:'unknown',estimatedUSD:null,estimatedCalls:0,excludedCalls:0,unknownCalls:0,complete:false}});
const tools={emptyMetrics:blank,normalizeUsage(raw){return raw===undefined?{sample:'missing',tokens:null}:{sample:'reported',tokens:{uncachedInputTokens:raw.inputTokens,outputTokens:raw.outputTokens,cacheReadTokens:raw.cacheReadTokens??null,cacheWriteTokens:raw.cacheWriteTokens??null,reasoningTokens:null,totalTokens:null}};},summarize(calls){return {...blank(),observedCalls:calls.length,coverage:calls.length?'complete':'unavailable'};}};
const usage={inputTokens:2,outputTokens:3,cacheReadTokens:0,cacheWriteTokens:0};
const settlement=(time,turn=1)=>({seq:5,time,type:'assistant/message',data:{turn,step:1,usage,message:{source:{provider:'p',model:'m'},content:'SECRET'}}});
function fixture(count=7) {
 let disposed=0, observed=[], listCount=0;
 const persistence={identity:{}};
 const entries=Array.from({length:count},(_,i)=>({header:{id:`s${i}`,createdAt:1,updatedAt:2,title:'SECRET',cwd:'/SECRET'},live:i===0,persisted:true}));
 const ctx={sessionPersistence:persistence,get(name){return this[name];},sessionQuery:{async listSessions(){listCount++;return entries;},async observeSession(id,opts){observed.push([id,opts]);return {source:id==='s0'?'live':'prepared',header:entries.find(x=>x.header.id===id).header,inheritedEventCount:0,cursor:5,revision:'v1',events:[settlement(100)], [Symbol.dispose](){disposed++;}};}}};
 return {ctx,entries,get disposed(){return disposed;},get observed(){return observed;},get listCount(){return listCount;}};
}
test('real metric factory counts child own calls without inherited seed duplication',async()=>{
 const f=fixture(2);const real=createMetricTools();
 f.ctx.sessionQuery.observeSession=async id=>({source:'prepared',revision:'r',header:f.entries.find(x=>x.header.id===id).header,inheritedEventCount:id==='s1'?1:0,cursor:10,events:id==='s1'?[settlement(100),settlement(200,2)]:[settlement(100)],[Symbol.dispose](){}});
 const page=await createReader(f.ctx,real).query({});const totals=real.mergeMetrics(page.rows.map(row=>row.metrics));
 assert.equal(totals.observedCalls,2);assert.equal(totals.tokens.uncachedInputTokens,4);assert.equal(totals.tokens.outputTokens,6);assert.equal(totals.tokens.totalTokens,10);assert.equal(totals.coverage,'complete');assert.equal(totals.cost.estimatedUSD,null);
});
test('real metrics propagate retained incomplete usage without leaking Call flags',async()=>{
 const f=fixture(1),real=createMetricTools();
 f.ctx.sessionQuery.observeSession=async()=>({source:'prepared',revision:'r',header:f.entries[0].header,inheritedEventCount:0,cursor:10,events:[settlement(100),{seq:6,time:200,type:'assistant/message',data:{turn:1,step:1,message:{source:{provider:'p',model:'m'}}}}],[Symbol.dispose](){}});
 const row=await createReader(f.ctx,real).session({sessionId:'s0'});assert.equal(row.metrics.observedCalls,1);assert.equal(row.metrics.missingCalls,0);assert.equal(row.metrics.tokens.uncachedInputTokens,2);assert.equal(row.metrics.coverage,'partial');assert.equal(row.last.timeMs,200);assert.ok(!JSON.stringify(row).includes('incomplete'));
});
test('five-session cohort opaque stable cursor and sanitized DTO',async()=>{
 const f=fixture();const reader=createReader(f.ctx,tools);
 const a=await reader.query({pinSessionId:'s6'});assert.equal(a.rows.length,5);assert.equal(a.rows[0].sessionId,'s6');assert.equal(a.totalSessions,7);assert.equal(a.scannedSessions,5);assert.equal(a.complete,false);assert.equal(f.disposed,5);
 f.entries.reverse();
 const b=await reader.query({cursor:a.nextCursor,pinSessionId:'s6'});assert.deepEqual(b.rows.map(r=>r.sessionId),['s4','s5']);assert.equal(b.complete,true);assert.equal(b.scannedSessions,7);assert.equal(f.listCount,1);assert.equal(f.disposed,7);assert.ok(f.observed.every(([,o])=>o.projectionMode==='none'));assert.ok(!JSON.stringify([a,b]).includes('SECRET'));assert.ok(!('calls' in a.rows[0]));
 reader.dispose();
});
test('settlement date filter, null timestamps and timezone day boundaries',async()=>{
 const f=fixture(1);f.ctx.sessionQuery.observeSession=async()=>({source:'prepared',header:f.entries[0].header,inheritedEventCount:0,cursor:10,events:[settlement(Date.UTC(2026,0,2,0,30)),settlement(null,2)], [Symbol.dispose](){}});
 const reader=createReader(f.ctx,tools);
 const row=await reader.session({sessionId:'s0',timeZone:'America/New_York'});assert.equal(row.metrics.observedCalls,2);assert.equal(row.days[0].day,'2026-01-01');assert.equal(row.days[1].day,null);
 const page=await reader.query({fromMs:Date.UTC(2026,0,2),toMs:Date.UTC(2026,0,3)});assert.equal(page.rows.length,1);assert.equal(page.rows[0].metrics.observedCalls,1);assert.equal(page.rows[0].excludedTimeCalls,1);assert.equal(page.rows[0].metrics.coverage,'partial');assert.equal(page.rows[0].metrics.cost.complete,false);
});
test('cursor binding, TTL, identity invalidation and validation errors are fixed',async()=>{
 let now=1;const f=fixture();const reader=createReader(f.ctx,tools,{now:()=>now,cursorTTLms:20});
 const first=await reader.query({});await assert.rejects(reader.query({cursor:first.nextCursor,fromMs:1}),{code:'INVALID_QUERY'});
 now=30;await assert.rejects(reader.query({cursor:first.nextCursor}),{code:'STALE_CURSOR'});
 const second=await reader.query({}); f.ctx.sessionPersistence={identity:{}}; await assert.rejects(reader.query({cursor:second.nextCursor}),{code:'STALE_CURSOR'});
 await assert.rejects(reader.query({timeZone:'NOT A ZONE'}),{code:'INVALID_QUERY'});await assert.rejects(reader.query({fromMs:20,toMs:10}),{code:'INVALID_QUERY'});
});
test('abort after acquisition always disposes and does not expose exception',async()=>{
 const f=fixture(1),controller=new AbortController();let closes=0;
 f.ctx.sessionQuery.observeSession=async()=>{controller.abort('SECRET');return {[Symbol.dispose](){closes++;},events:[]};};
 const reader=createReader(f.ctx,tools);await assert.rejects(reader.session({sessionId:'s0'},controller.signal),error=>error.code==='ABORTED'&&!error.message.includes('SECRET'));assert.equal(closes,1);
});
test('upstream exceptions are unavailable rows and no metadata leaks',async()=>{
 const f=fixture(1);f.ctx.sessionQuery.observeSession=async()=>{throw new Error('/SECRET apiKey');};
 const reader=createReader(f.ctx,tools);const row=await reader.session({sessionId:'s0'});assert.equal(row.source,'unavailable');assert.equal(row.metrics.coverage,'unavailable');assert.ok(!JSON.stringify(row).includes('SECRET'));
 const page=await reader.query({});assert.equal(page.skippedSessions,1);assert.equal(page.rows[0].source,'unavailable');
 f.ctx.sessionQuery.listSessions=async()=>{throw new Error('SECRET');};await assert.rejects(reader.query({}),{code:'SOURCE_UNAVAILABLE',message:'SOURCE_UNAVAILABLE'});
});
test('replacement live generation with same cursor is not stale cached',async()=>{
 const f=fixture(1);let events=[settlement(1)];
 f.ctx.sessionQuery.observeSession=async()=>({source:'live',header:f.entries[0].header,inheritedEventCount:0,cursor:5,events,[Symbol.dispose](){}});
 const reader=createReader(f.ctx,tools);assert.equal((await reader.session({sessionId:'s0'})).metrics.observedCalls,1);events=[settlement(1),settlement(2,2)];assert.equal((await reader.session({sessionId:'s0'})).metrics.observedCalls,2);
});
test('truncation marks all retained metrics partial and cost incomplete',async()=>{
 const f=fixture(1);const reader=createReader(f.ctx,tools,{maxEvents:1});
 f.ctx.sessionQuery.observeSession=async()=>({source:'prepared',header:f.entries[0].header,inheritedEventCount:0,cursor:5,events:[settlement(100),settlement(200,2)],[Symbol.dispose](){}});
 const row=await reader.session({sessionId:'s0'});assert.equal(row.truncated,true);for(const m of [row.metrics,row.last.metrics,row.models[0].metrics,row.days[0].metrics]){assert.equal(m.coverage,'partial');assert.equal(m.cost.complete,false);}
});
test('fresh Cordis traced proxies share canonical identities without unwrapping method calls',async()=>{
 const f=fixture(7),original=Symbol.for('cordis.original');
 const trace=target=>new Proxy(target,{get(object,key,receiver){return key===original?object:Reflect.get(object,key,receiver);}});
 let queryTarget=f.ctx.sessionQuery,persistenceIdentity={};
 const list=queryTarget.listSessions,observe=queryTarget.observeSession;
 queryTarget={async listSessions(...args){assert.notEqual(this,queryTarget);assert.equal(this[original],queryTarget);return list(...args);},async observeSession(...args){assert.notEqual(this,queryTarget);assert.equal(this[original],queryTarget);const value=await observe(...args);return {...value,source:'prepared'};}};
 const persistenceTarget={get identity(){return trace(persistenceIdentity);}};
 Object.defineProperty(f.ctx,'sessionQuery',{get:()=>trace(queryTarget)});
 Object.defineProperty(f.ctx,'sessionPersistence',{get:()=>trace(persistenceTarget)});
 let normalized=0;const reader=createReader(f.ctx,{...tools,normalizeUsage(raw){normalized++;return tools.normalizeUsage(raw);}});
 assert.equal((await reader.session({sessionId:'s0'})).metrics.observedCalls,1);assert.equal((await reader.session({sessionId:'s0'})).metrics.observedCalls,1);assert.equal(normalized,1);assert.equal(f.disposed,2);
 const page=await reader.query({});const next=await reader.query({cursor:page.nextCursor});assert.equal(next.complete,true);assert.equal(next.rows.length,2);
 const another=await reader.query({});persistenceIdentity={};await assert.rejects(reader.query({cursor:another.nextCursor}),{code:'STALE_CURSOR'});
 const final=await reader.query({});queryTarget={...queryTarget};await assert.rejects(reader.query({cursor:final.nextCursor}),{code:'STALE_CURSOR'});
});
test('concurrent profile change cannot admit an older pending observation',async()=>{
 const f=fixture(1);let resolveOld,closes=0;
 const observe=()=>({source:'prepared',revision:'same',header:f.entries[0].header,inheritedEventCount:0,cursor:5,events:[settlement(100)],[Symbol.dispose](){closes++;}});
 f.ctx.sessionQuery.observeSession=()=>new Promise(resolve=>{resolveOld=resolve;});
 const reader=createReader(f.ctx,tools),pending=reader.session({sessionId:'s0'});f.ctx.sessionPersistence={identity:{}};
 f.ctx.sessionQuery.observeSession=async()=>observe();await reader.session({sessionId:'s0'});resolveOld(observe());
 await assert.rejects(pending,{code:'STALE_CURSOR'});assert.equal(closes,2);
});
test('prepared cache uses revision and persistence identity; cache hits still release leases',async()=>{
 const f=fixture(1);let revision='one',closes=0,normalized=0;
 const counted={...tools,normalizeUsage(raw){normalized++;return tools.normalizeUsage(raw);}};
 f.ctx.sessionQuery.observeSession=async()=>({source:'prepared',revision,header:f.entries[0].header,inheritedEventCount:0,cursor:5,events:[settlement(100)],[Symbol.dispose](){closes++;}});
 const reader=createReader(f.ctx,counted);await reader.session({sessionId:'s0'});await reader.session({sessionId:'s0'});assert.equal(normalized,1);assert.equal(closes,2);
 revision='two';await reader.session({sessionId:'s0'});assert.equal(normalized,2);f.ctx.sessionPersistence={identity:{}};await reader.session({sessionId:'s0'});assert.equal(normalized,3);reader.dispose();await assert.rejects(reader.session({sessionId:'s0'}),{code:'SOURCE_UNAVAILABLE'});
});
test('invalid limits are safe and snapshot source cap never silently drops sessions',async()=>{
 const f=fixture(2);assert.throws(()=>createReader(f.ctx,tools,{pageSize:6}),{code:'INVALID_QUERY'});assert.throws(()=>createReader(f.ctx,tools,null),{code:'INVALID_QUERY'});
 await assert.rejects(createReader(f.ctx,tools,{maxSnapshotSessions:1}).query({}),{code:'SOURCE_UNAVAILABLE'});
 await assert.rejects(createReader(f.ctx,tools).query({timeZone:'+01:00'}),{code:'INVALID_QUERY'});
});
test('cursor retries preserve cohort and abort does not advance the saved position',async()=>{
 const f=fixture(7),reader=createReader(f.ctx,tools);const first=await reader.query({});
 const controller=new AbortController();controller.abort('SECRET');await assert.rejects(reader.query({cursor:first.nextCursor},controller.signal),{code:'ABORTED'});
 const second=await reader.query({cursor:first.nextCursor});const retry=await reader.query({cursor:first.nextCursor});assert.deepEqual(second.rows.map(r=>r.sessionId),retry.rows.map(r=>r.sessionId));assert.equal(retry.scannedSessions,7);
});
test('changed observed cursor invalidates sanitized counts; lease disposed on cache hit',async()=>{
 const f=fixture(1);let cursor=1;
 f.ctx.sessionQuery.observeSession=async()=>({source:'live',header:f.entries[0].header,inheritedEventCount:0,cursor,events:[settlement(1),...(cursor===2?[settlement(2,2)]:[])],[Symbol.dispose](){}});
 const reader=createReader(f.ctx,tools);assert.equal((await reader.session({sessionId:'s0'})).metrics.observedCalls,1);cursor=2;assert.equal((await reader.session({sessionId:'s0'})).metrics.observedCalls,2);
});
