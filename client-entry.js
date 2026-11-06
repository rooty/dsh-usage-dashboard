import * as React from 'react';

/*__METRIC_TOOLS__*/

// PURE START
export function numberText(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '—';
}
export function costText(cost) {
  if (cost?.estimatedUSD != null) {
    const format = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 5 });
    const amount = cost.estimatedUSD > 0 && cost.estimatedUSD < 0.00001 ? `<${format.format(0.00001)}` : format.format(cost.estimatedUSD);
    return `${amount} estimate${cost.complete === false ? ' (partial)' : ''}`;
  }
  return cost?.mode === 'subscription-route' ? 'Subscription / not calculated' : 'Cost unavailable';
}
export function badgeText(cost) {
  if (Number.isFinite(cost?.estimatedUSD) && cost.estimatedUSD >= 0) {
    if (cost.estimatedUSD > 0 && cost.estimatedUSD < 0.00005) return 'Usage · ≈<$0.0001';
    const amount=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',notation:cost.estimatedUSD>=1000?'compact':'standard',minimumFractionDigits:4,maximumFractionDigits:4}).format(cost.estimatedUSD);
    return `Usage · ≈${amount}`;
  }
  return cost?.mode==='subscription-route'?'Usage · Subscription':'Usage · —';
}
function midnight(date, zone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Error('Invalid date');
  const target = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(target) || new Date(target).toISOString().slice(0, 10) !== date) throw Error('Invalid date');
  const formatter = new Intl.DateTimeFormat('en-CA', {timeZone: zone, year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  let result = target;
  for (let i=0;i<6;i++) {
    const parts = Object.fromEntries(formatter.formatToParts(result).map(p=>[p.type,p.value]));
    const represented = Date.UTC(+parts.year,+parts.month-1,+parts.day,+parts.hour,+parts.minute,+parts.second);
    const delta = target-represented;
    if (!delta) return result;
    result += delta;
  }
  throw Error('This date has no local midnight');
}
export function dateRange(from, through, zone) {
  const fromMs = from ? midnight(from, zone) : null;
  let toMs = null;
  if (through) {
    midnight(through, zone);
    const next = new Date(Date.parse(`${through}T00:00:00Z`)+86400000).toISOString().slice(0,10);
    toMs = midnight(next, zone);
  }
  if (fromMs != null && toMs != null && fromMs >= toMs) throw Error('Invalid range');
  return {fromMs,toMs};
}
export function collectRows(previous, incoming) {
  const rows = new Map(previous.map(row=>[row.sessionId,row]));
  for (const row of incoming) rows.set(row.sessionId,row);
  return [...rows.values()];
}
export function groupRows(rows, type, tools) {
  const grouped = new Map();
  for (const row of rows) for (const part of row[type] ?? []) {
    const key = type === 'models' ? JSON.stringify([part.provider,part.model]) : JSON.stringify(part.day);
    if (!grouped.has(key)) grouped.set(key,{...part,parts:[]});
    grouped.get(key).parts.push(part.metrics);
  }
  return [...grouped.values()].map(({parts,...row})=>({...row,metrics:tools.mergeMetrics(parts)}));
}
// Source completeness cannot be inferred from usage samples alone: an empty live
// session and an unreadable log both contribute emptyMetrics to the pure merge.
export function pageMetrics(page, tools) {
  const rows=page?.rows??[];
  const unavailableSessions=rows.filter(row=>row.source==='unavailable').length;
  const skippedSessions=page?.skippedSessions??0;
  const incompleteSources=unavailableSessions>0||skippedSessions>0;
  const merged=tools.mergeMetrics(rows.map(row=>row.metrics));
  const metrics=incompleteSources?{...merged,coverage:merged.coverage==='unavailable'?'unavailable':'partial',cost:{...merged.cost,complete:false}}:merged;
  return {metrics,incompleteSources,unavailableSessions,skippedSessions};
}
// A bounded chart of observed day totals, never null-as-zero or billing curves.
export function dailyChartData(days) {
  const known=days.filter(row=>typeof row.day==='string' && /^\d{4}-\d{2}-\d{2}$/.test(row.day) && Number.isSafeInteger(row.metrics?.tokens?.totalTokens) && row.metrics.tokens.totalTokens>=0)
    .map(row=>({day:row.day,totalTokens:row.metrics.tokens.totalTokens,partial:row.metrics.coverage!=='complete'}))
    .sort((a,b)=>a.day.localeCompare(b.day));
  const points=known.slice(-60);
  return {points,omitted:Math.max(0,known.length-points.length),unknown:days.length-known.length,partial:points.some(point=>point.partial),max:Math.max(0,...points.map(point=>point.totalTokens))};
}
export async function postUsage(kind, body, signal, fetcher = globalThis.fetch) {
  if (kind !== 'session' && kind !== 'query') throw Error('Usage unavailable');
  const response = await fetcher(`/api/local-usage-dashboard/${kind}`, {
    method:'POST',credentials:'same-origin',cache:'no-store',signal,
    headers:{'Content-Type':'application/json','X-DSH-Usage':'1'},body:JSON.stringify(body)
  });
  let value;
  try {value=await response.json();} catch {throw Error('Usage unavailable');}
  if (value?.ok === false && value.error?.code === 'STALE_CURSOR') {
    const error=Error('Usage unavailable');error.code='STALE_CURSOR';throw error;
  }
  if (!response.ok || value?.ok !== true || value.schemaVersion !== 1 || !(kind === 'session' ? value.session : value.page)) throw Error('Usage unavailable');
  return value;
}
// One controller per mounted UI. A generation fence remains necessary even when a
// transport ignores abort; cache keys include the entire request scope.
export function createResource(request) {
  let state={scope:null,data:null,loading:false,error:null,stale:false},generation=0,abort,disposed=false;
  const listeners=new Set(),cache=new Map();
  const emit=()=>{for(const listener of listeners) listener();};
  const setScope=scope=>{
    generation++; abort?.abort();
    state={scope,data:cache.get(scope)??null,loading:false,error:null,stale:cache.has(scope)}; emit();
  };
  return {
    getSnapshot:()=>state,
    subscribe:listener=>{listeners.add(listener);return ()=>listeners.delete(listener);},
    setScope,
    activate(){disposed=false;},
    async load(scope,argument=scope,merge) {
      if(disposed) return;
      if(state.scope!==scope) setScope(scope);
      abort?.abort(); abort=new AbortController(); const signal=abort.signal,version=++generation;
      state={...state,loading:true,error:null};emit();
      try {
        const result=await request(argument,signal);
        if(disposed||version!==generation) return;
        const data=merge ? merge(state.data,result) : result;
        cache.set(scope,data);if(cache.size>20) cache.delete(cache.keys().next().value);
        state={scope,data,loading:false,error:null,stale:false};emit();
      } catch (error) {
        if(disposed||version!==generation) return;
        const message=error?.code==='STALE_CURSOR'?'Session list expired. Refresh to restart the cohort.':'Usage unavailable. Refresh to retry.';
        state={...state,loading:false,error:message,stale:state.data!=null};emit();
      }
    },
    dispose(){disposed=true;generation++;abort?.abort();state={...state,loading:false};listeners.clear();}
  };
}
// Top-layer popover when supported, semantic inline dialog otherwise. All DOM
// handling belongs to this component's refs, never native widget selectors.
export function bindPopover(node, trigger, onClose) {
  const doc=node.ownerDocument;
  let finished=false;
  const close=()=>{if(finished)return;finished=true;onClose();trigger?.focus();};
  const key=event=>{if(event.key==='Escape'){event.preventDefault();close();}};
  const outside=event=>{if(!node.contains(event.target)&&!trigger?.contains(event.target))close();};
  const toggle=event=>{if(event.newState==='closed')close();};
  doc.addEventListener('keydown',key);doc.addEventListener('pointerdown',outside);
  node.addEventListener?.('toggle',toggle);
  let native=false;
  const viewport=doc.defaultView;
  const position=()=>{
    const rect=trigger.getBoundingClientRect();
    const width=viewport?.innerWidth??800,height=viewport?.innerHeight??800;
    const panelWidth=node.offsetWidth||370,panelHeight=node.offsetHeight||0;
    node.style.position='fixed';node.style.margin='0';node.style.inset='auto';
    node.style.left=`${Math.max(8,Math.min(rect.left,width-panelWidth-8))}px`;
    if(rect.top>=panelHeight+16) node.style.bottom=`${Math.max(8,height-rect.top+8)}px`;
    else node.style.top=`${Math.max(8,Math.min(rect.bottom+8,height-panelHeight-8))}px`;
  };
  if(typeof node.showPopover==='function') {
    try{node.style.inset='auto';node.showPopover();native=true;position();}catch{node.removeAttribute?.('popover');}
  }
  if(native){viewport?.addEventListener('resize',position);doc.addEventListener('scroll',position,true);}
  (node.querySelector('button')??node).focus();
  return ()=>{
    finished=true;doc.removeEventListener('keydown',key);doc.removeEventListener('pointerdown',outside);node.removeEventListener?.('toggle',toggle);
    if(native){viewport?.removeEventListener('resize',position);doc.removeEventListener('scroll',position,true);try{node.hidePopover();}catch{/* already dismissed */}}
  };
}
// PURE END

const h=React.createElement;
const metricTools=createMetricTools();
const tokenLabels=[['uncachedInputTokens','Input (uncached)'],['outputTokens','Output'],['cacheReadTokens','Cache read'],['cacheWriteTokens','Cache write'],['reasoningTokens','Reasoning (within output)'],['totalTokens','Total']];
const css=`
.local-usage{font-family:inherit;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);box-sizing:border-box}
.local-usage *{box-sizing:border-box}.local-usage button,.local-usage input{font:inherit;color:inherit}
.local-usage button{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);padding:4px 8px;cursor:pointer}
.local-usage button:hover{background:var(--dsw-alias-interactive-bg-hover)}.local-usage button:disabled{opacity:.5;cursor:default}
.local-usage :focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.local-usage p{margin:8px 0}.local-usage small,.local-usage .muted{color:var(--dsw-alias-label-tertiary);font-size:12px}
.local-usage h2{font-family:inherit;font-weight:500;font-size:16px;line-height:24px;margin:0}.local-usage h3{font-size:13px;font-weight:500;margin:12px 0 6px}
.local-usage dl{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 16px;margin:8px 0}.local-usage dd{margin:0;font-variant-numeric:tabular-nums}.local-usage dt{color:var(--dsw-alias-label-secondary)}
.local-usage .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.local-usage .between{justify-content:space-between}
.local-usage-page{height:100%;overflow:auto;padding:24px clamp(16px,4vw,40px);background:var(--dsw-alias-bg-base)}
.local-usage-page .content{max-width:1100px;margin:auto}.local-usage-page header{padding:8px 0 16px;border-bottom:1px solid var(--dsw-alias-border-l3)}
.local-usage-page form{display:flex;gap:12px;flex-wrap:wrap;align-items:end;margin:16px 0}.local-usage-page label{display:flex;flex-direction:column;gap:4px}
.local-usage-page input{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 8px;max-width:100%}
.local-usage-page [role=tablist]{display:flex;gap:8px;margin:16px 0 8px}.local-usage [aria-selected=true]{background:var(--dsw-alias-interactive-bg-hover);font-weight:500}
.local-usage-page .table-scroll{overflow-x:auto}.local-usage table{border-collapse:collapse;width:100%;text-align:left;font-variant-numeric:tabular-nums}
.local-usage th,.local-usage td{padding:8px;border-bottom:1px solid var(--dsw-alias-border-l3);white-space:nowrap}.local-usage th{font-weight:500;color:var(--dsw-alias-label-secondary)}
.local-usage td:first-child{max-width:270px;overflow:hidden;text-overflow:ellipsis}.local-usage footer{margin-top:16px}
.local-usage-dock{display:flex;justify-content:flex-end;position:relative}.local-usage-dock>.badge{border:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.local-usage-mini{width:min(370px,calc(100vw - 16px));max-height:70vh;overflow:auto;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-base));box-shadow:var(--dsw-elevation-panel);color:var(--dsw-alias-label-primary)}
.local-usage-mini:not([popover]){position:static;margin:8px 0}.local-usage-mini::backdrop{background:transparent}
`;
function Style(){return h('style',null,css);}
function Metrics({metrics}) {
  const m=metrics??metricTools.emptyMetrics();
  return h(React.Fragment,null,
    h('p',null,costText(m.cost)),
    h('dl',null,...tokenLabels.map(([key,label])=>h(React.Fragment,{key},h('dt',null,label),h('dd',null,numberText(m.tokens[key]))))),
    h('p',{className:'muted'},`${numberText(m.observedCalls)} calls with reported usage; ${m.coverage} usage coverage. ${numberText(m.missingCalls)} calls missing usage, ${numberText(m.invalidCalls)} invalid.`),
    h('p',{className:'muted'},`Cost coverage: ${numberText(m.cost.estimatedCalls)} estimated, ${numberText(m.cost.excludedCalls)} possible subscription route, ${numberText(m.cost.unknownCalls)} unknown.`));
}
function Provenance({data}) {
  const pricing=data?.pricing;
  return h('p',{className:'muted'},`Catalog estimate only, not an invoice or account balance. ${pricing?.source??'pi-ai-catalog'} ${pricing?.catalogVersion??'1.3.0'}, USD. Possible subscription routes are excluded, not verified billing. Settlement-time basis.`,data?.generatedAtMs ? ` Updated ${new Date(data.generatedAtMs).toLocaleString()}.`:'');
}
function Status({state}) {return h('p',{role:'status',className:'muted'},state.error??(state.loading?'Loading usage…':state.data?'':'No usage loaded.'),state.stale?' Showing cached / stale data.':'');}
function useResource(request) {
  const [resource]=React.useState(()=>createResource(request));
  React.useEffect(()=>{resource.activate();return()=>resource.dispose();},[resource]);
  return [React.useSyncExternalStore(resource.subscribe,resource.getSnapshot,resource.getSnapshot),resource];
}
function useOwnSession(sessionId, invalidation, open, timeZone) {
  const [state,resource]=useResource((body,signal)=>postUsage('session',body,signal));
  const refresh=React.useCallback(()=>{if(sessionId)resource.load(sessionId,{sessionId,timeZone});},[resource,sessionId,timeZone]);
  React.useEffect(()=>{resource.setScope(sessionId??null);if(sessionId)refresh();},[resource,sessionId,refresh]);
  React.useEffect(()=>{if(!sessionId)return;const timer=setTimeout(refresh,250);return()=>clearTimeout(timer);},[sessionId,invalidation,refresh]);
  // Native tokenUsage invalidates settled own metrics. A bounded 10s fallback
  // only while open covers same-total settlements/metadata-only changes.
  React.useEffect(()=>{if(!open||!sessionId)return;refresh();const timer=setInterval(refresh,10000);return()=>clearInterval(timer);},[open,sessionId,refresh]);
  // Hide previous-session data even in the render preceding effect cleanup.
  return [state.scope===(sessionId??null)?state:{data:null,loading:false,error:null,stale:false},refresh];
}
function MiniBody({state,refresh,context,onClose,onNavigate}) {
  const row=state.data?.session;
  return h(React.Fragment,null,
    h('div',{className:'row between'},h('h2',null,'Session usage'),h('button',{type:'button',onClick:onClose,'aria-label':'Close usage'},'Close')),
    h(Status,{state}),row?h('p',{className:'muted'},`Own calls only; inherited history excluded. ${row.source} source. Sequence ${numberText(row.asOfSeq)}.`):null,h(Metrics,{metrics:row?.metrics}),
    row?.truncated?h('p',{className:'muted'},'Bounded history: this session is truncated.'):null,
    h('h3',null,'Last settled call'),row?.last ? h(React.Fragment,null,
      h('p',{className:'muted'},`${row.last.provider??'Unknown provider'} / ${row.last.model??'Unknown model'}; turn ${row.last.turn}, step ${row.last.step}, attempt ${row.last.attempt}. ${row.last.timeMs==null?'Time unknown':new Date(row.last.timeMs).toLocaleString()}`),
      h(Metrics,{metrics:row.last.metrics})) : h('p',{className:'muted'},'No own settled call available.'),
    context ? h('p',{className:'muted'},context):null,
    h(Provenance,{data:state.data}),h('div',{className:'row'},h('button',{type:'button',disabled:state.loading,onClick:refresh},'Refresh'),h('button',{type:'button',onClick:onNavigate},'Open Usage')));
}
function Dock({sessionId,useProjection,onNavigate}) {
  const [open,setOpen]=React.useState(false),trigger=React.useRef(null),panel=React.useRef(null);
  const id=React.useId();
  const tokenUsage=useProjection ? useProjection('tokenUsage') : null;
  const pressure=useProjection ? useProjection('contextPressure') : null;
  const timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone??'UTC';
  const [state,refresh]=useOwnSession(sessionId,tokenUsage,open,timeZone);
  const close=React.useCallback(()=>setOpen(false),[]);
  React.useEffect(()=>{if(!open||!panel.current)return;return bindPopover(panel.current,trigger.current,close);},[open,close]);
  const supported=typeof HTMLElement!=='undefined' && 'showPopover' in HTMLElement.prototype;
  const used=pressure?.projectedTokens??pressure?.pressureTokens;
  const nativeContext=Number.isFinite(used)&&Number.isFinite(pressure?.contextWindow)&&pressure.contextWindow>0 ? `Native context pressure: ${Math.round(used/pressure.contextWindow*100)}% (heuristic, not session usage).` : null;
  return h('div',{className:'local-usage local-usage-dock'},h(Style),
    h('button',{ref:trigger,type:'button',className:'badge',title:costText(state.data?.session?.metrics?.cost),'aria-haspopup':'dialog','aria-expanded':open,'aria-controls':id,onClick:()=>setOpen(v=>!v)},badgeText(state.data?.session?.metrics?.cost)),
    open?h('section',{ref:panel,id,role:'dialog','aria-label':'Session usage',tabIndex:-1,popover:supported?'auto':undefined,className:'local-usage local-usage-mini'},h(MiniBody,{state,refresh,context:nativeContext,onClose:()=>{close();trigger.current?.focus();},onNavigate:()=>{close();onNavigate();}})):null);
}
function DailyChart({days,incompleteSources=false}) {
  const chart=dailyChartData(days),width=720,height=180,padding=42,plotHeight=120;
  const partial=chart.partial||incompleteSources;
  const step=(width-padding*2)/Math.max(chart.points.length,1);
  return h('figure',{style:{margin:'16px 0'}},
    h('figcaption',null,'Daily total tokens (loaded sessions)',partial?' · Partial dataset / usage coverage':''),
    chart.points.length?h('svg',{viewBox:`0 0 ${width} ${height}`,role:'img','aria-label':`Daily observed total tokens for ${chart.points.length} days${partial?', partial dataset or usage coverage':''}. Known totals only.`,style:{display:'block',width:'100%',maxHeight:'220px',color:'var(--dsw-alias-label-secondary)'}},
      h('line',{x1:padding,y1:plotHeight+12,x2:width-padding,y2:plotHeight+12,stroke:'currentColor',opacity:.25}),
      h('text',{x:padding-6,y:18,textAnchor:'end',fill:'currentColor',fontSize:11},numberText(chart.max)),
      ...chart.points.map((point,index)=>{
        const barHeight=chart.max?point.totalTokens/chart.max*plotHeight:0;
        return h('rect',{key:point.day,x:padding+index*step+step*.15,y:plotHeight+12-barHeight,width:step*.7,height:barHeight,fill:'currentColor',opacity:point.partial ? 0.45 : 0.8},h('title',null,`${point.day}: ${numberText(point.totalTokens)} tokens${point.partial?' (partial coverage)':''}`));
      }),
      h('text',{x:padding,y:height-12,fill:'currentColor',fontSize:11},chart.points[0].day),
      h('text',{x:width-padding,y:height-12,textAnchor:'end',fill:'currentColor',fontSize:11},chart.points.at(-1).day))
      :h('p',{className:'muted'},'No known daily total-token samples to chart.'),
    h('p',{className:'muted'},`Latest ${chart.points.length} known settlement days, up to 60. ${chart.unknown} unavailable or unknown-date totals skipped, not treated as zero.${chart.omitted?` ${chart.omitted} earlier known days omitted from chart.`:''} Dates without samples are not interpolated; use the table for exact days. Partial bars show known usage only.`));
}
function UsagePage({currentSource,onClose}) {
  const binding=React.useSyncExternalStore(currentSource.subscribe,currentSource.getSnapshot,currentSource.getSnapshot);
  const currentId=binding?.key;
  const [tab,setTab]=React.useState('Sessions'),[from,setFrom]=React.useState(''),[through,setThrough]=React.useState(''),[filterError,setFilterError]=React.useState(null);
  const [timeZone]=React.useState(()=>Intl.DateTimeFormat().resolvedOptions().timeZone??'UTC');
  const [query,setQuery]=React.useState(()=>({timeZone}));
  const [state,resource]=useResource((body,signal)=>postUsage('query',body,signal));
  const scope=JSON.stringify(query);
  React.useEffect(()=>{resource.setScope(scope);resource.load(scope,query);},[scope,resource]);
  const active=state.scope===scope?state:{data:null,loading:false,error:null,stale:false};
  const data=active.data,rows=data?.page.rows??[],page=data?.page;
  const {metrics,incompleteSources,unavailableSessions,skippedSessions}=pageMetrics(page,metricTools);
  const grouped=tab==='Sessions'?rows:groupRows(rows,tab==='Models'?'models':'days',metricTools);
  const reload=()=>resource.load(scope,query);
  const next=()=>resource.load(scope,{...query,cursor:page.nextCursor},(previous,incoming)=>({...incoming,page:{...incoming.page,rows:collectRows(previous?.page.rows??[],incoming.page.rows)}}));
  const apply=event=>{event.preventDefault();try{const range=dateRange(from,through,timeZone);setFilterError(null);setQuery({...range,timeZone,pinSessionId:currentId});}catch{setFilterError('Choose valid dates, with From on or before Through.');}};
  const columns=['Calls with usage',...tokenLabels.map(([,label])=>label),'Cost estimate','Coverage'];
  return h('main',{className:'local-usage local-usage-page'},h(Style),h('div',{className:'content'},
    h('header',null,h('div',{className:'row between'},h('h2',null,'Usage'),h('div',{className:'row'},h('button',{type:'button',onClick:reload,disabled:active.loading},'Refresh'),h('button',{type:'button',onClick:onClose,'aria-label':'Close Usage and return to chat'},'Close'))),h('p',{className:'muted'},'Own settled calls in loaded sessions. Inherited conversation history is excluded.'),currentId?h('p',{className:'muted'},`Current session: ${currentId}`):null),
    h('form',{onSubmit:apply},h('label',null,'From',h('input',{type:'date',value:from,onChange:e=>setFrom(e.target.value)})),h('label',null,'Through',h('input',{type:'date',value:through,onChange:e=>setThrough(e.target.value)})),h('button',{type:'submit'},'Apply dates'),h('span',{className:'muted'},`${timeZone}; settlement date`)),
    filterError?h('p',{role:'alert'},filterError):null,h(Status,{state:active}),
    h('p',{role:'status'},page?`${rows.length} loaded / ${page.totalSessions} known sessions; ${page.scannedSessions} scanned, ${page.skippedSessions} skipped. ${page.complete?'All session headers scanned.':'More session headers available.'}`:'Load a cohort to see usage.'),
    h('p',{className:'muted'},'Totals below cover loaded sessions only. The native session header list is unpaged; Load next 5 bounds log reads, not header enumeration.'),
    h(Metrics,{metrics}),
    incompleteSources?h('p',{role:'status',className:'muted'},`Partial dataset: ${unavailableSessions} loaded session sources unavailable; ${skippedSessions} sessions skipped. Totals, models and days include known usage only. Complete per-model or per-day sample coverage does not mean all session logs were readable.`):null,
    h('div',{role:'tablist','aria-label':'Usage breakdown'},...['Sessions','Models','Days'].map(name=>h('button',{key:name,id:`usage-tab-${name}`,type:'button',role:'tab','aria-selected':name===tab,'aria-controls':'usage-results',tabIndex:name===tab?0:-1,onClick:()=>setTab(name),onKeyDown:event=>{const names=['Sessions','Models','Days'];let index=names.indexOf(tab);if(event.key==='ArrowRight')index=(index+1)%3;else if(event.key==='ArrowLeft')index=(index+2)%3;else if(event.key==='Home')index=0;else if(event.key==='End')index=2;else return;event.preventDefault();setTab(names[index]);event.currentTarget.parentElement.children[index].focus();}},name))),
    h('div',{id:'usage-results',role:'tabpanel','aria-labelledby':`usage-tab-${tab}`,tabIndex:0,className:'table-scroll'},
      tab==='Days'?h(DailyChart,{days:grouped,incompleteSources}):null,
      h('table',null,h('thead',null,h('tr',null,h('th',{scope:'col'},tab==='Sessions'?'Session':tab==='Models'?'Provider / model':'Settlement day'),...columns.map(name=>h('th',{key:name,scope:'col'},name)))),
        h('tbody',null,...grouped.map((row,index)=>h('tr',{key:tab==='Sessions'?row.sessionId:index},h('td',null,tab==='Sessions'?row.sessionId:tab==='Models'?`${row.provider??'Unknown provider'} / ${row.model??'Unknown model'}`:row.day??'Unknown timestamp'),h('td',null,numberText(row.metrics.observedCalls)),...tokenLabels.map(([key])=>h('td',{key},numberText(row.metrics.tokens[key]))),h('td',null,costText(row.metrics.cost)),h('td',null,`${row.metrics.coverage}${row.truncated?' / truncated':''}${row.source==='unavailable'?' / unavailable':''}${row.excludedTimeCalls?` / ${row.excludedTimeCalls} unknown-time excluded`:''}`))))),
      !grouped.length?h('p',{className:'muted'},active.loading?'Loading…':'No settled usage available for this loaded cohort and date range.'):null),
    h('footer',null,page?.nextCursor?h('button',{type:'button',disabled:active.loading,onClick:next},'Load next 5'):null,h(Provenance,{data}),h('p',{className:'muted'},'Missing counters stay unavailable. Partial coverage is not a complete spending report. Refresh restarts the cohort; expired cursors require Refresh.'))));
}
function UsageIcon(){return h('svg',{width:18,height:18,viewBox:'0 0 20 20',fill:'none','aria-hidden':true},h('path',{d:'M3 16h14M5 13V9m5 4V4m5 9V7',stroke:'currentColor',strokeWidth:1.5,strokeLinecap:'round'}));}
export const inject=['slots','locale','layout','uiSession'];
export function apply(ctx) {
  ctx.effect(()=>ctx.locale.register('local.usage',{en:{title:'Usage'}}));
  const t=ctx.locale.bind('local.usage');
  ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'local.usage',locale:'local.usage',inject:()=>({currentSource:ctx.uiSession.current,onClose:()=>ctx.layout.selectPanel(null)})},UsagePage));
  ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:'local.usage',order:65,label:()=>t('title')},UsageIcon));
  ctx.slots.inject('conversation.composer.dock',()=>ctx.slots.register({name:'conversation.composer.dock',id:'local.usage-dashboard',order:90,inject:sessionId=>({sessionId,onNavigate:()=>ctx.layout.selectPanel('local.usage')})},Dock));
}
