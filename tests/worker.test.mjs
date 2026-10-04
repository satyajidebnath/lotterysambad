import test from 'node:test';
import assert from 'node:assert/strict';
import {todayResult,updateResult,updateAllResults} from '../src/result.mjs';
import worker, {ResultUpdater} from '../src/worker.mjs';
import {pollResults} from '../src/poll.mjs';
import {firstPrize} from '../src/prize.mjs';
function bucket(){
 const data=new Map();
 const metadata=new Map();
 return {data,async get(key){const value=data.get(key);if(value===undefined)return null;return {body:new Response(value).body,httpEtag:'"test-etag"',writeHttpMetadata(headers){for(const [name,value] of Object.entries(metadata.get(key)||{})){headers.set(name==='contentType'?'Content-Type':'Cache-Control',value);}},json:async()=>JSON.parse(value),arrayBuffer:async()=>value};},async put(key,value,options){data.set(key,value);metadata.set(key,options?.httpMetadata);}};
}
const date=new Date('2026-10-04T12:00:00Z');
test('uses India date across year boundary',()=>{
 assert.equal(todayResult(new Date('2026-12-31T19:00:00Z')).filename,'MN010127.PDF');
});
test('downloads and converts once, then returns daily cache',async()=>{
 const env={RESULTS:bucket()};let downloads=0,renders=0;
 const original=globalThis.fetch;
 globalThis.fetch=async()=>{downloads++;return new Response('%PDF-1.7 test');};
 try{
  const render=async()=>{renders++;return [{bytes:new Uint8Array([1]),width:100,height:200}];};
  assert.equal((await updateResult(env,render,date)).status,'updated');
  assert.equal((await updateResult(env,render,date)).status,'cached');
  assert.equal(downloads,1);assert.equal(renders,1);
  const latest=JSON.parse(env.RESULTS.data.get('latest-MN.json'));
  assert.equal(latest.pages[0].src,'/images/results/2026-10-04/MN/page-1.png');
 }finally{globalThis.fetch=original;}
});
test('failed conversion retries saved PDF and preserves previous result',async()=>{
 const env={RESULTS:bucket()};env.RESULTS.data.set('latest-MN.json','old result');
 let downloads=0;const original=globalThis.fetch;
 globalThis.fetch=async()=>{downloads++;return new Response('%PDF-1.7 test');};
 try{
  await assert.rejects(updateResult(env,async()=>{throw Error('browser unavailable');},date),/browser unavailable/);
  assert.equal(env.RESULTS.data.get('latest-MN.json'),'old result');
  await updateResult(env,async()=>[{bytes:new Uint8Array([1]),width:100,height:200}],date);
  assert.equal(downloads,1);
 }finally{globalThis.fetch=original;}
});
test('unpublished source is never cached or published',async()=>{
 const env={RESULTS:bucket()};const original=globalThis.fetch;
 globalThis.fetch=async()=>new Response('<html>not published</html>');
 try{await assert.rejects(updateResult(env,()=>assert.fail('must not render'),date),/not published/);assert.equal(env.RESULTS.data.size,0);}
 finally{globalThis.fetch=original;}
});
test('simultaneous updater calls share one operation',async()=>{
 const env={RESULTS:bucket()};const today=todayResult();
 for(const draw of ['MN','DN','EN'])env.RESULTS.data.set(`results/${today.date}/${draw}/result.json`,JSON.stringify({...today,draw,pages:[]}));
 let writes=0;const put=env.RESULTS.put;
 env.RESULTS.put=async(...args)=>{if(args[0]==='latest.json')writes++;await put(...args);};
 const updater=new ResultUpdater({},env);
 const responses=await Promise.all([updater.fetch(),updater.fetch(),updater.fetch()]);
 for(const response of responses)assert.equal((await response.json()).status,'cached');
 assert.equal(writes,1);
});
test('public visits never invoke conversion and update endpoint requires token',async()=>{
 let calls=0;
 const env={ADMIN_TOKEN:'test-private-token',RESULTS:bucket(),UPDATER:{get(){calls++;throw Error('unexpected update');}}};
 const missing=await worker.fetch(new Request('https://example.com/result.json'),env,{});
 assert.equal(missing.status,503);
 const unauthorized=await worker.fetch(new Request('https://example.com/admin/update',{method:'POST'}),env,{});
 assert.equal(unauthorized.status,401);assert.equal(calls,0);
});
test('oversized download is canceled before rendering or saving',async()=>{
 const original=globalThis.fetch;let canceled=false;
 globalThis.fetch=async()=>new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(1024*1024));},cancel(){canceled=true;}}));
 const env={RESULTS:bucket()};
 try{
  await assert.rejects(updateResult(env,()=>assert.fail('must not render'),date),/20 MB/);
  assert.equal(canceled,true);assert.equal(env.RESULTS.data.size,0);
 }finally{globalThis.fetch=original;}
});
test('oversized Content-Length is rejected without reading the body',async()=>{
 const original=globalThis.fetch;let canceled=false;
 globalThis.fetch=async()=>new Response(new ReadableStream({cancel(){canceled=true;}}),{headers:{'Content-Length':String(21*1024*1024)}});
 try{
  await assert.rejects(updateResult({RESULTS:bucket()},()=>assert.fail('must not render'),date),/20 MB/);
  assert.equal(canceled,true);
 }finally{globalThis.fetch=original;}
});
test('invalid render output never replaces the published result',async()=>{
 const env={RESULTS:bucket()};env.RESULTS.data.set('latest-MN.json','previous');
 env.RESULTS.data.set('results/2026-10-04/MN/MN041026.PDF',new TextEncoder().encode('%PDF-1.7').buffer);
 for(const output of [[],Array(11).fill({bytes:new Uint8Array([1]),width:100,height:100}),[{bytes:new Uint8Array([1]),width:NaN,height:100}]]){
  await assert.rejects(updateResult(env,async()=>output,date));
  assert.equal(env.RESULTS.data.get('latest-MN.json'),'previous');
  assert.equal(env.RESULTS.data.has('results/2026-10-04/MN/result.json'),false);
 }
});
test('partial image writes remain unpublished and can be retried',async()=>{
 const env={RESULTS:bucket()};env.RESULTS.data.set('latest-MN.json','previous');
 env.RESULTS.data.set('results/2026-10-04/MN/MN041026.PDF',new TextEncoder().encode('%PDF-1.7').buffer);
 const put=env.RESULTS.put;env.RESULTS.put=async(key,...args)=>{if(key.endsWith('page-2.png'))throw Error('storage failure');return put(key,...args);};
 const render=async()=>Array(2).fill({bytes:new Uint8Array([1]),width:100,height:100});
 await assert.rejects(updateResult(env,render,date),/storage failure/);
 assert.equal(env.RESULTS.data.get('latest-MN.json'),'previous');
 assert.equal(env.RESULTS.data.has('results/2026-10-04/MN/result.json'),false);
 env.RESULTS.put=put;assert.equal((await updateResult(env,render,date)).status,'updated');
});
test('HEAD returns no body for an unavailable result',async()=>{
 const response=await worker.fetch(new Request('https://example.com/result.json',{method:'HEAD'}),{RESULTS:bucket()},{});
 assert.equal(response.status,503);assert.equal(await response.text(),'');assert.equal(response.headers.get('Retry-After'),'60');
});
test('images support GET, HEAD, ETags and invalid paths',async()=>{
 const oldCaches=globalThis.caches,entries=new Map();
 globalThis.caches={default:{async match(key){return entries.get(key.url)?.clone();},async put(key,value){entries.set(key.url,value);}}};
 const env={RESULTS:bucket()},pending=[],ctx={waitUntil(task){pending.push(task);}};
 const url='https://example.com/images/results/2026-10-04/MN/page-1.png';
 await env.RESULTS.put('results/2026-10-04/MN/page-1.png',new Uint8Array([1,2,3]),{httpMetadata:{contentType:'image/png',cacheControl:'public, max-age=31536000, immutable'}});
 try{
  const head=await worker.fetch(new Request(url,{method:'HEAD'}),env,ctx);
  assert.equal(await head.text(),'');assert.equal(pending.length,0);
  const get=await worker.fetch(new Request(url),env,ctx);
  assert.deepEqual(new Uint8Array(await get.arrayBuffer()),new Uint8Array([1,2,3]));
  assert.equal(get.headers.get('Content-Type'),'image/png');await Promise.all(pending);
  const conditional=await worker.fetch(new Request(url,{headers:{'If-None-Match':'W/"test-etag"'}}),env,ctx);
  assert.equal(conditional.status,304);assert.equal(await conditional.text(),'');
  assert.equal((await worker.fetch(new Request('https://example.com/images/invalid'),env,ctx)).status,404);
 }finally{globalThis.caches=oldCaches;}
});
test('authorized update forwards to the Durable Object',async()=>{
 let calls=0;
 const env={ADMIN_TOKEN:'private',UPDATER:{idFromName(name){assert.equal(name,'daily-result');return name;},get(){return {async fetch(){calls++;return Response.json({status:'cached'});}};}}};
 const response=await worker.fetch(new Request('https://example.com/admin/update',{method:'POST',headers:{Authorization:'Bearer private'}}),env,{});
 assert.equal((await response.json()).status,'cached');assert.equal(calls,1);
});
test('all three filenames use the India date and their own prefix',()=>{
 for(const draw of ['MN','DN','EN'])assert.equal(todayResult(new Date('2026-12-31T19:00:00Z'),draw).filename,`${draw}010127.PDF`);
});
test('first prize comes from PDF text and preserves leading zeros',()=>{
 assert.deepEqual(firstPrize([{text:'1st Prize 72A 07421 2nd Prize 12382'}]),{series:'72A',number:'07421'});
 assert.equal(firstPrize([{text:'2nd prize 07421 12382'}]),null);
});
test('each draw starts at its own exact IST download time',async()=>{
 const env={RESULTS:bucket()},original=globalThis.fetch,downloads=[];
 globalThis.fetch=async url=>{downloads.push(new URL(url).searchParams.get('filename'));return new Response('%PDF-1.7');};
 const render=async()=>[{bytes:new Uint8Array([1]),width:100,height:100}];
 try{
  await updateAllResults(env,render,new Date('2026-10-04T07:39:59Z'));assert.deepEqual(downloads,[]);
  await updateAllResults(env,render,new Date('2026-10-04T07:40:00Z'));assert.deepEqual(downloads,['MN041026.PDF']);
  await updateAllResults(env,render,new Date('2026-10-04T12:39:59Z'));assert.equal(downloads.length,1);
  await updateAllResults(env,render,new Date('2026-10-04T12:40:00Z'));assert.deepEqual(downloads,['MN041026.PDF','DN041026.PDF']);
  await updateAllResults(env,render,new Date('2026-10-04T14:39:59Z'));assert.equal(downloads.length,2);
  await updateAllResults(env,render,new Date('2026-10-04T14:40:00Z'));assert.deepEqual(downloads,['MN041026.PDF','DN041026.PDF','EN041026.PDF']);
  await updateAllResults(env,render,new Date('2026-10-04T17:00:00Z'));assert.equal(downloads.length,3);
  assert.equal(JSON.parse(env.RESULTS.data.get('latest.json')).draws.filter(draw=>draw.status==='ready').length,3);
 }finally{globalThis.fetch=original;}
});
test('an unavailable draw does not prevent the other two results',async(t)=>{
 t.mock.method(console,'warn',()=>{});
 const env={RESULTS:bucket()},original=globalThis.fetch;
 globalThis.fetch=async url=>new Response(url.includes('DN')?'<html>not uploaded</html>':'%PDF-1.7');
 try{
  await updateAllResults(env,async()=>[{bytes:new Uint8Array([1]),width:100,height:100}],new Date('2026-10-04T15:00:00Z'));
  const manifest=JSON.parse(env.RESULTS.data.get('latest.json'));
  assert.deepEqual(manifest.draws.map(draw=>draw.status),['ready','pending','ready']);assert.equal(manifest.draws[1].result,null);
 }finally{globalThis.fetch=original;}
});
test('polls every ten seconds, publishes the missing state, and stops when found',async(t)=>{
 t.mock.method(console,'warn',()=>{});
 const env={RESULTS:bucket()},original=globalThis.fetch;let requests=0,time=new Date('2026-10-04T07:40:00Z'),waits=[],states=[];
 globalThis.fetch=async()=>new Response(++requests===1?'not found':'%PDF-1.7');
 try{
  await pollResults(env,async()=>[{bytes:new Uint8Array([1]),width:100,height:100}],{now:()=>time,wait:async duration=>{waits.push(duration);time=new Date(+time+duration);},publish:async manifest=>states.push(manifest.draws[0].status)});
  assert.deepEqual(waits,[10000]);assert.deepEqual(states,['pending','ready']);assert.equal(requests,2);
  await pollResults(env,()=>assert.fail('completed results must not render'),{now:()=>time,wait:()=>assert.fail('must stop')});assert.equal(requests,2);
 }finally{globalThis.fetch=original;}
});
test('polling stops at the India date boundary',async(t)=>{
 t.mock.method(console,'warn',()=>{});
 const env={RESULTS:bucket()},original=globalThis.fetch;let time=new Date('2026-10-04T18:29:55Z'),requests=0;
 globalThis.fetch=async()=>{requests++;return new Response('not published');};
 try{
  await pollResults(env,()=>assert.fail('must not render'),{now:()=>time,wait:async duration=>{time=new Date(+time+duration);}});
  assert.equal(requests,3);assert.equal(JSON.parse(env.RESULTS.data.get('latest.json')).date,'2026-10-04');
 }finally{globalThis.fetch=original;}
});
