import test from 'node:test';
import assert from 'node:assert/strict';
import { createFold } from './fold.js';
const tools = { normalizeUsage(raw) { return raw === undefined ? {sample:'missing',tokens:null} : typeof raw?.inputTokens !== 'number' ? {sample:'invalid',tokens:null} : {sample:'reported',tokens:{uncachedInputTokens:raw.inputTokens,outputTokens:raw.outputTokens,cacheReadTokens:null,cacheWriteTokens:null,reasoningTokens:null,totalTokens:null}}; } };
const usage = n => ({inputTokens:n,outputTokens:1});
const event = (type,data,time=100,seq=99) => ({type,data,time,seq});
const settle = (n,extra={}) => event('assistant/message',{turn:1,step:1,usage:usage(n),...extra});
test('physical inherited prefix seeds route but not calls or retries',()=>{
 const fold=createFold(tools,{inheritedEventCount:3});
 fold.push(event('request/header',{header:{config:{provider:'p',model:'m',apiKey:'SECRET'}}}));
 fold.push(settle(100)); fold.push(event('llm/retry-started',{turn:1,step:1}));
 fold.push(settle(2)); const result=fold.finish();
 assert.equal(result.calls.length,1); assert.equal(result.calls[0].attempt,0); assert.equal(result.calls[0].provider,'p'); assert.equal(result.calls[0].tokens.uncachedInputTokens,2); assert.ok(!JSON.stringify(result).includes('SECRET'));
});
test('replacement, last stream usage, retry ordinal and authoritative source',()=>{
 const fold=createFold(tools); fold.push(settle(1));
 fold.push(event('assistant/attempt',{turn:1,step:1,stream:[{type:'chunk',chunk:{type:'usage',usage:usage(2)}},{type:'chunk',chunk:{type:'usage',usage:usage(3)}}]}));
 fold.push(event('llm/retry-started',{turn:1,step:1}));
 fold.push(settle(4,{message:{source:{provider:'actual',model:'route'},content:'SECRET'}}));
 const {calls}=fold.finish(); assert.deepEqual(calls.map(c=>c.tokens.uncachedInputTokens),[3,4]); assert.equal(calls[1].attempt,1); assert.equal(calls[1].provider,'actual'); assert.ok(!JSON.stringify(calls).includes('SECRET'));
});
test('missing/invalid and unknown time are retained without raw values',()=>{
 const fold=createFold(tools); fold.push(event('assistant/message',{turn:1,step:1,message:{}},'bad'));
 fold.push(event('assistant/message',{turn:1,step:2,usage:{inputTokens:'SECRET'}},null));
 const {calls}=fold.finish(); assert.deepEqual(calls.map(c=>c.sample),['missing','invalid']); assert.equal(calls[0].timeMs,null); assert.equal(calls[1].tokens,null);
});
test('later missing or invalid sample preserves known usage but explicitly marks incomplete',()=>{
 for (const raw of [undefined,{inputTokens:'SECRET'}]) {
  const fold=createFold(tools);fold.push(settle(7,{message:{source:{provider:'actual',model:'route'}}}));
  fold.push(event('assistant/message',{turn:1,step:1,usage:raw,message:{source:{provider:'final',model:'m'}}},200));
  const {calls}=fold.finish();assert.equal(calls.length,1);assert.equal(calls[0].sample,'reported');assert.equal(calls[0].tokens.uncachedInputTokens,7);assert.equal(calls[0].incomplete,true);assert.equal(calls[0].provider,'final');assert.equal(calls[0].timeMs,200);assert.ok(!JSON.stringify(calls).includes('SECRET'));
 }
});
test('stream record bound is explicit and latest settlement remains last',()=>{
 const fold=createFold(tools,{maxStreamRecords:1});
 fold.push(event('assistant/attempt',{turn:1,step:1,stream:[{type:'chunk',chunk:{type:'usage',usage:usage(2)}},{type:'chunk',chunk:{type:'text',text:'SECRET'}}]}));
 fold.push(event('assistant/message',{turn:2,step:1,usage:usage(3)}));fold.push(settle(4));
 const result=fold.finish();assert.equal(result.truncated,true);assert.equal(result.calls.at(-1).turn,1);assert.equal(result.calls.at(-1).tokens.uncachedInputTokens,4);
});
test('caps remain explicit and replacement within retained slot remains accurate',()=>{
 const fold=createFold(tools,{maxCalls:1,maxEvents:4}); fold.push(settle(1));fold.push(settle(2));fold.push(event('assistant/message',{turn:2,step:1,usage:usage(3)}));
 assert.equal(fold.finish().calls[0].tokens.uncachedInputTokens,2);assert.equal(fold.finish().truncated,true);
});
