import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
// Exercise pure helpers without a fake renderer or any real logs/API calls.
const source = await readFile(new URL('./client-entry.js', import.meta.url), 'utf8');
const pure = source.slice(source.indexOf('// PURE START'), source.indexOf('// PURE END')).replaceAll('export ', '');
const { numberText, costText, badgeText, dateRange, createResource, collectRows, groupRows, dailyChartData, pageMetrics, postUsage, bindPopover } = new Function(`${pure}; return {numberText,costText,badgeText,dateRange,createResource,collectRows,groupRows,dailyChartData,pageMetrics,postUsage,bindPopover}`)();
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b}); return {promise,resolve,reject}; };
test('null is unavailable, not zero; cost is explicitly an estimate', () => {
 assert.equal(numberText(null),'—'); assert.equal(numberText(0),'0');
 assert.match(costText({mode:'estimate',estimatedUSD:0}),/estimate/);
 assert.equal(costText({mode:'subscription-route',estimatedUSD:null}),'Subscription / not calculated');
 assert.equal(costText({mode:'unknown',estimatedUSD:null}),'Cost unavailable');
});
test('positive subprecision catalog costs never format as free', () => {
 const threshold=new Intl.NumberFormat(undefined,{style:'currency',currency:'USD',maximumFractionDigits:5}).format(0.00001);
 assert.equal(costText({estimatedUSD:1e-9,complete:false}),`<${threshold} estimate (partial)`);
 assert.equal(costText({estimatedUSD:0.000009}),`<${threshold} estimate`);
 assert.equal(costText({estimatedUSD:0.00001}),`${threshold} estimate`);
 assert.equal(costText({estimatedUSD:0}).startsWith('<'),false);
});
test('dock badge remains compact while popup preserves full policy and coverage', () => {
 assert.equal(badgeText({estimatedUSD:0.01234,complete:false}),'Usage · ≈$0.0123');
 assert.equal(badgeText({estimatedUSD:0}),'Usage · ≈$0.0000');
 assert.equal(badgeText({estimatedUSD:0.000001}),'Usage · ≈<$0.0001');
 assert.equal(badgeText({mode:'subscription-route',estimatedUSD:null}),'Usage · Subscription');
 assert.equal(badgeText(null),'Usage · —');
 assert.match(costText({estimatedUSD:0.01234,complete:false}),/estimate \(partial\)/);
});
test('calendar boundaries follow selected current timezone including DST', () => {
 assert.deepEqual(dateRange('2026-03-29','2026-03-29','Europe/Warsaw'),{fromMs:Date.parse('2026-03-28T23:00Z'),toMs:Date.parse('2026-03-29T22:00Z')});
 assert.throws(() => dateRange('2026-02-30','','UTC'));
 assert.throws(() => dateRange('2026-04-02','2026-04-01','UTC'));
});
test('resource aborts and fences old scope, caches only matching session and retains stale failure', async () => {
 const a=deferred(), b=deferred(); let firstSignal;
 const resource=createResource((arg,signal) => {if(arg==='a'){firstSignal=signal;return a.promise;} return b.promise;});
 const old=resource.load('a'), latest=resource.load('b');
 assert.equal(firstSignal.aborted,true); a.resolve('wrong'); await old;
 assert.equal(resource.getSnapshot().data,null); b.resolve('correct'); await latest;
 assert.equal(resource.getSnapshot().data,'correct');
 resource.setScope('a'); assert.equal(resource.getSnapshot().data,null);
 resource.setScope('b'); assert.equal(resource.getSnapshot().data,'correct');
 const failing=createResource(async () => {throw Error('secret server text')});
 await failing.load('x'); assert.equal(failing.getSnapshot().error,'Usage unavailable. Refresh to retry.');
 resource.dispose(); assert.equal(resource.getSnapshot().loading,false);
});
test('refresh failure preserves same-scope cached metrics with stale label', async () => {
 let fail=false; const r=createResource(async()=>{if(fail)throw Error('private');return {metrics:'known'};});
 await r.load('session-a'); fail=true; await r.load('session-a');
 assert.deepEqual(r.getSnapshot().data,{metrics:'known'}); assert.equal(r.getSnapshot().stale,true);
 assert.equal(r.getSnapshot().error,'Usage unavailable. Refresh to retry.');
 r.setScope('session-b'); assert.equal(r.getSnapshot().data,null); assert.equal(r.getSnapshot().error,null);
});
test('disposed resource ignores late completion and unsubscribe releases listener', async () => {
 const d=deferred(); const r=createResource(() => d.promise); let changed=0;
 const unsubscribe=r.subscribe(()=>changed++); const request=r.load('s'); unsubscribe(); r.dispose();
 const count=changed; d.resolve('late'); await request;
 assert.equal(changed,count); assert.equal(r.getSnapshot().data,null);
});
test('effect replay can reactivate controller after cleanup without publishing old request', async () => {
 const d=deferred(); let count=0; const r=createResource(()=>++count===1?d.promise:Promise.resolve('new'));
 const old=r.load('s'); r.dispose(); r.activate(); await r.load('s'); d.resolve('old'); await old;
 assert.equal(r.getSnapshot().data,'new');
});
test('page cohorts dedupe sessions before merging model/day metrics', () => {
 const rows=collectRows([{sessionId:'a',models:[{provider:'p',model:'m',metrics:1}]}],[{sessionId:'a',models:[{provider:'p',model:'m',metrics:2}]},{sessionId:'b',models:[{provider:'p',model:'m',metrics:3}]}]);
 assert.equal(rows.length,2); assert.equal(rows[0].models[0].metrics,2);
 const grouped=groupRows(rows,'models',{mergeMetrics:xs=>xs.reduce((a,b)=>a+b,0)});
 assert.equal(grouped[0].metrics,5);
});
test('HTTP uses exact same-origin carrier and custom header, hides failures', async () => {
 let seen; const fetcher=async (...args) => {seen=args;return {ok:true,json:async()=>({ok:true,schemaVersion:1,session:{sessionId:'s'}})}};
 await postUsage('session',{sessionId:'s'},undefined,fetcher);
 assert.equal(seen[0],'/api/local-usage-dashboard/session'); assert.equal(seen[1].credentials,'same-origin'); assert.equal(seen[1].headers['X-DSH-Usage'],'1');
 await assert.rejects(postUsage('other',{},undefined,fetcher));
 await assert.rejects(postUsage('session',{},undefined,async()=>({ok:false})),/Usage unavailable/);
});
test('stale cursor maps to fixed restart instruction even on non-2xx without exposing raw text', async () => {
 const fetcher=async()=>({ok:false,json:async()=>({ok:false,error:{code:'STALE_CURSOR',message:'private details'}})});
 const r=createResource((body,signal)=>postUsage('query',body,signal,fetcher)); await r.load('scope',{});
 assert.equal(r.getSnapshot().error,'Session list expired. Refresh to restart the cohort.');
});
test('page source completeness downgrades known totals, not healthy empty sessions', () => {
 const merged={coverage:'complete',tokens:{totalTokens:42},cost:{complete:true,estimatedUSD:0.1}};
 const tools={mergeMetrics:()=>merged};
 const healthy={source:'live',metrics:{}},unavailable={source:'unavailable',metrics:{}};
 const result=pageMetrics({rows:[healthy,unavailable],skippedSessions:0},tools);
 assert.equal(result.incompleteSources,true);assert.equal(result.unavailableSessions,1);assert.equal(result.metrics.coverage,'partial');assert.equal(result.metrics.cost.complete,false);assert.equal(result.metrics.tokens.totalTokens,42);
 assert.equal(merged.coverage,'complete');assert.equal(merged.cost.complete,true);
 const skipped=pageMetrics({rows:[healthy],skippedSessions:1},tools);assert.equal(skipped.metrics.coverage,'partial');assert.equal(skipped.metrics.cost.complete,false);
 const liveEmpty=pageMetrics({rows:[healthy,{source:'stored',metrics:{}}],skippedSessions:0},tools);assert.equal(liveEmpty.incompleteSources,false);assert.equal(liveEmpty.metrics.coverage,'complete');assert.equal(liveEmpty.metrics.cost.complete,true);
 const noKnown=pageMetrics({rows:[unavailable],skippedSessions:0},{mergeMetrics:()=>({coverage:'unavailable',cost:{complete:false},tokens:{totalTokens:null}})});assert.equal(noKnown.metrics.coverage,'unavailable');assert.equal(noKnown.metrics.tokens.totalTokens,null);
});
test('daily chart limits latest known days, skips null instead of zero, preserves partial coverage', () => {
 const day=(date,total,coverage='complete')=>({day:date,metrics:{tokens:{totalTokens:total},coverage}});
 const result=dailyChartData([day('2026-11-01',null),day(null,50),day('2026-11-03',0),day('2026-11-02',20,'partial')]);
 assert.deepEqual(result.points,[{day:'2026-11-02',totalTokens:20,partial:true},{day:'2026-11-03',totalTokens:0,partial:false}]);
 assert.equal(result.unknown,2);assert.equal(result.partial,true);assert.equal(result.max,20);
 const rows=Array.from({length:65},(_,i)=>day(new Date(Date.UTC(2026,0,i+1)).toISOString().slice(0,10),i));
 const bounded=dailyChartData(rows.reverse()); assert.equal(bounded.points.length,60);assert.equal(bounded.omitted,5);assert.equal(bounded.points[0].totalTokens,5);
});
test('native popover resets UA inset, reanchors on resize/scroll and cleans up listeners', () => {
 const events=new Map(),windowEvents=new Map();let left=80,hidden=0;
 const viewport={innerWidth:900,innerHeight:700,addEventListener:(k,v)=>windowEvents.set(k,v),removeEventListener:k=>windowEvents.delete(k)};
 const doc={defaultView:viewport,addEventListener:(k,v)=>events.set(k,v),removeEventListener:k=>events.delete(k)};
 const node={ownerDocument:doc,style:{inset:'0'},offsetWidth:370,offsetHeight:200,contains:()=>false,addEventListener(){},removeEventListener(){},querySelector:()=>null,focus(){},showPopover(){assert.equal(this.style.inset,'auto');},hidePopover(){hidden++;}};
 const trigger={contains:()=>false,focus(){},getBoundingClientRect:()=>({left,top:500,bottom:530})};
 const dispose=bindPopover(node,trigger,()=>{});assert.equal(node.style.inset,'auto');assert.equal(node.style.bottom,'208px');assert.equal(node.style.left,'80px');
 left=100;windowEvents.get('resize')();assert.equal(node.style.left,'100px');left=120;events.get('scroll')();assert.equal(node.style.left,'120px');
 dispose();assert.equal(hidden,1);assert.equal(events.size,0);assert.equal(windowEvents.size,0);
});
test('popover lifecycle dismisses outside/Escape, returns focus, removes handlers', () => {
 const events=new Map(); const doc={addEventListener:(k,v)=>events.set(k,v),removeEventListener:k=>events.delete(k)};
 let focused=0,closed=0; const trigger={contains:()=>false,focus:()=>focused++};
 const node={ownerDocument:doc,contains:()=>false,querySelector:()=>null,focus(){},style:{}};
 const dispose=bindPopover(node,trigger,()=>closed++);
 events.get('keydown')({key:'Escape',preventDefault(){}}); assert.equal(closed,1); assert.equal(focused,1);
 dispose(); assert.equal(events.size,0);
});
