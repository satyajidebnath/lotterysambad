import {readFile,writeFile,mkdir,copyFile,access} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import puppeteer from '@cloudflare/puppeteer/internal/puppeteer-core.js';
import {renderPDF} from '../src/render.mjs';
import {pollResults} from '../src/poll.mjs';
import {publishPages} from './publish-pages.mjs';
import {firstPrize} from '../src/prize.mjs';
import {DRAWS} from '../src/draws.mjs';
const cache=resolve('.result-cache'),output=resolve('.site');
const storedPath=key=>{
 if(!/^latest(?:-(?:MN|DN|EN))?\.json$/.test(key)&&!/^results\/\d{4}-\d{2}-\d{2}\/(MN|DN|EN)\/(?:result\.json|(?:MN|DN|EN)\d{6}\.PDF|page-\d+\.png)$/.test(key))throw Error('Invalid storage key.');
 return resolve(cache,key);
};
const RESULTS={async get(key){try{const bytes=await readFile(storedPath(key));return {json:async()=>JSON.parse(bytes.toString()),arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};}catch(error){if(error.code==='ENOENT')return null;throw error;}},async put(key,value){const path=storedPath(key);await mkdir(dirname(path),{recursive:true});await writeFile(path,value instanceof ArrayBuffer?new Uint8Array(value):value);}};
// Seed each draw independently. Also migrate the original morning-only result.
try{
 const seed=JSON.parse(await readFile('result.json','utf8'));
 for(const draw of seed.draws||[{id:'MN',result:seed}]){
  if(!draw.result||await RESULTS.get(`latest-${draw.id}.json`))continue;
  const result=draw.result,pages=[];
  for(const [index,page] of result.pages.entries()){
   const original=page.src.replace(/^\//,'');
   if(!new RegExp(`^images/results/\\d{4}-\\d{2}-\\d{2}/(?:${draw.id}/)?page-${index+1}\\.png$`).test(original))throw Error('Invalid seed image path.');
   const key=`results/${result.date}/${draw.id}/page-${index+1}.png`;
   await RESULTS.put(key,await readFile(original));pages.push({...page,src:`/images/${key}`});
  }
  const manifest={...result,draw:draw.id,pages};
  await RESULTS.put(`results/${result.date}/${draw.id}/result.json`,JSON.stringify(manifest));
  await RESULTS.put(`latest-${draw.id}.json`,JSON.stringify(manifest));
 }
}catch(error){if(error.code!=='ENOENT')throw error;}
const env={RESULTS,ASSETS:{async fetch(request){const path=new URL(request.url).pathname;if(!['/vendor/pdf.min.mjs','/vendor/pdf.worker.min.mjs'].includes(path))return new Response(null,{status:404});return new Response(await readFile(resolve('vendor',path.split('/').at(-1))));}}};
async function render(pdf,env){
 const executablePath=process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/google-chrome');await access(executablePath);
 return renderPDF(pdf,env,{launch:()=>puppeteer.launch({executablePath,headless:true,args:['--no-sandbox','--disable-gpu','--disable-gpu-sandbox','--disable-software-rasterizer'],userDataDir:resolve('test-artifacts',`pages-chrome-${randomUUID()}`)})});
}
// Upgrade previous saved manifests using their cached PDF, without source hits.
for(const draw of DRAWS){
 const saved=await RESULTS.get(`latest-${draw.id}.json`);if(!saved)continue;
 const result=await saved.json();if('firstPrize' in result&&result.imageFormat==='trimmed-v1')continue;
 const key=`results/${result.date}/${draw.id}/${result.filename}`;
 let pdf=await RESULTS.get(key);
 if(!pdf&&/^(MN|DN|EN)\d{6}\.PDF$/.test(result.filename)){
  try{await RESULTS.put(key,await readFile(resolve(cache,'results',result.date,result.filename)));pdf=await RESULTS.get(key);}catch(error){if(error.code!=='ENOENT')throw error;}
 }
 if(pdf){
  const images=await render(await pdf.arrayBuffer(),env);result.firstPrize=firstPrize(images);result.imageFormat='trimmed-v1';result.pages=[];
  for(const [index,image] of images.entries()){const imageKey=`results/${result.date}/${draw.id}/page-${index+1}.png`;await RESULTS.put(imageKey,image.bytes);result.pages.push({src:`/images/${imageKey}`,width:image.width,height:image.height});}
 }else result.firstPrize??=null;
 await RESULTS.put(`latest-${draw.id}.json`,JSON.stringify(result));
 await RESULTS.put(`results/${result.date}/${draw.id}/result.json`,JSON.stringify(result));
}
await pollResults(env,render,{once:!process.argv.includes('--watch'),publish:async(manifest)=>{
 const result=structuredClone(manifest);
 for(const draw of result.draws){
  if(!draw.result)continue;
  for(const page of draw.result.pages){const key=page.src.replace(/^\/images\//,''),target=resolve(output,'images',key);await mkdir(dirname(target),{recursive:true});await copyFile(storedPath(key),target);page.src=`images/${key}`;}
 }
 await mkdir(output,{recursive:true});await copyFile('index.html',resolve(output,'index.html'));await writeFile(resolve(output,'result.json'),JSON.stringify(result,null,2));await writeFile(resolve(output,'.nojekyll'),'');
 console.log(`Prepared ${result.date}: ${result.draws.map(draw=>`${draw.id} ${draw.status}`).join(', ')}`);
 if(process.argv.includes('--publish'))await publishPages(output);
}});
