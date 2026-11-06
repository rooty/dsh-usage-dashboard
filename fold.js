// Deliberately dependency-free. Never retain an event, message, config or stream.
const integer = value => Number.isSafeInteger(value) && value >= 0;
export const routePart = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
export const epochMs = value => integer(value) && value <= 8640000000000000 ? value : null;
export function safeError(code) { const error = new Error(code); error.code = code; return error; }
export function limitOption(value, fallback, maximum) {
 if (value === undefined) return fallback;
 if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw safeError('INVALID_QUERY');
 return value;
}
function usageOf(event, budget) {
 if (event.type === 'assistant/message' && event.data?.usage !== undefined) return {usage:event.data.usage,scanned:0,truncated:false};
 const stream = event.data?.stream;
 let scanned=0;
 if (Array.isArray(stream)) for (let i=stream.length-1;i>=0;i--) {
  if (scanned>=budget) return {usage:undefined,scanned,truncated:true};
  scanned++;
  const record=stream[i];
  if (record?.type==='chunk' && record.chunk?.type==='usage') return {usage:record.chunk.usage,scanned,truncated:false};
 }
 return {usage:undefined,scanned,truncated:false};
}
export function createFold(metricTools, options={}) {
 if (options===null || typeof options!=='object' || Array.isArray(options)) throw safeError('INVALID_QUERY');
 const maxCalls=limitOption(options.maxCalls,5000,50000), maxEvents=limitOption(options.maxEvents,100000,1000000);
 const maxStreamRecords=limitOption(options.maxStreamRecords,100000,1000000);
 const inherited=options.inheritedEventCount ?? 0;
 if (!integer(inherited)) throw safeError('INVALID_QUERY');
 let offset=0,truncated=false,remainingStreamRecords=maxStreamRecords,route={provider:null,model:null};
 const calls=new Map(), attempts=new Map();
 return {
  push(event) {
   const physicalOffset=offset++;
   if (physicalOffset>=maxEvents) {truncated=true;return;}
   if (event?.type==='request/header') {
    const config=event.data?.header?.config;
    route={provider:routePart(config?.provider),model:routePart(config?.model)};
   }
   // inheritedEventCount counts physical records, NOT seq values supplied by a fixture/import.
   if (physicalOffset<inherited) return;
   const data=event?.data;
   if (!integer(data?.turn)||!integer(data?.step)) return;
   const slot=`${data.turn}:${data.step}`;
   if (event.type==='llm/retry-started') {
    if (attempts.has(slot) || attempts.size<maxCalls) attempts.set(slot,(attempts.get(slot)??0)+1);
    else truncated=true;
    return;
   }
   if (event.type!=='assistant/message' && event.type!=='assistant/attempt') return;
   const attempt=attempts.get(slot)??0, id=`${slot}:${attempt}`;
   if (!calls.has(id) && calls.size>=maxCalls) {truncated=true;return;}
   // Bound retry bookkeeping independently of how many settlements contain usage.
   if (!attempts.has(slot)) {
    if (attempts.size>=maxCalls) {truncated=true;return;}
    attempts.set(slot,0);
   }
   const source=event.type==='assistant/message'?data.message?.source:undefined;
   const actual=source!==undefined ? {provider:routePart(source?.provider),model:routePart(source?.model)} : route;
   const found=usageOf(event,remainingStreamRecords);
   remainingStreamRecords-=found.scanned;
   truncated ||= found.truncated;
   const sample=metricTools.normalizeUsage(found.usage);
   const previous=calls.get(id);
   const incomplete=previous?.sample==='reported' && sample.sample!=='reported';
   const retained=incomplete?previous:sample;
   const attribution=incomplete && source===undefined?previous:actual;
   calls.delete(id);
   calls.set(id,{id,turn:data.turn,step:data.step,attempt,timeMs:epochMs(event.time),provider:attribution.provider,model:attribution.model,sample:retained.sample,tokens:retained.tokens===null?null:{...retained.tokens},...(incomplete?{incomplete:true}:{})});
  },
  finish() {return {calls:[...calls.values()].map(call=>({...call,tokens:call.tokens===null?null:{...call.tokens}})),truncated};}
 };
}
