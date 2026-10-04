import {setTimeout as delay} from 'node:timers/promises';
import {indiaDateParts} from './draws.mjs';
import {updateAllResults} from './result.mjs';
export async function pollResults(env,render,{now=()=>new Date(),wait=delay,publish=async()=>{},once=false,maxDuration=330*60*1000}={}){
 const started=now(),day=indiaDateParts(started).date;let previous='';
 while(indiaDateParts(now()).date===day&&now()-started<maxDuration){
  const tick=now();await updateAllResults(env,render,tick);
  const manifest=await(await env.RESULTS.get('latest.json')).json();
  const signature=JSON.stringify({date:manifest.date,draws:manifest.draws});
  if(signature!==previous){await publish(manifest);previous=signature;}
  if(once||!manifest.draws.some(draw=>draw.status==='pending'))return manifest;
  // Completed draws use the daily manifest and never re-download their PDF.
  await wait(Math.max(0,10000-(now()-tick)));
 }
 return (await env.RESULTS.get('latest.json'))?.json();
}
