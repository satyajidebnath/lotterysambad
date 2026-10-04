import {readFile,writeFile,mkdir,copyFile,access} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import puppeteer from '@cloudflare/puppeteer/internal/puppeteer-core.js';
import {renderPDF} from '../src/render.mjs';
import {updateResult} from '../src/result.mjs';

const cache=resolve('.result-cache'),output=resolve('.site');
const storedPath=key=>{
 if(key!=='latest.json'&&!/^results\/\d{4}-\d{2}-\d{2}\/(?:result\.json|MN\d{6}\.PDF|page-\d+\.png)$/.test(key))throw Error('Invalid storage key.');
 return resolve(cache,key);
};
const RESULTS={
 async get(key){
  try{
   const bytes=await readFile(storedPath(key));
   return {json:async()=>JSON.parse(bytes.toString()),arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};
  }catch(error){if(error.code==='ENOENT')return null;throw error;}
 },
 async put(key,value){const path=storedPath(key);await mkdir(dirname(path),{recursive:true});await writeFile(path,value instanceof ArrayBuffer?new Uint8Array(value):value);}
};
// A committed result makes the first deployment usable without a cache.
if(!await RESULTS.get('latest.json')){
 try{
  const seed=JSON.parse(await readFile('result.json','utf8'));
  for(const [index,page] of seed.pages.entries()){
   const expected=`images/results/${seed.date}/page-${index+1}.png`;
   if(page.src!==expected)throw Error('Invalid seed image path.');
   await RESULTS.put(`results/${seed.date}/page-${index+1}.png`,await readFile(expected));
  }
  const manifest={...seed,pages:seed.pages.map(page=>({...page,src:`/${page.src}`}))};
  await RESULTS.put(`results/${seed.date}/result.json`,JSON.stringify(manifest));
  await RESULTS.put('latest.json',JSON.stringify(manifest));
 }catch(error){if(error.code!=='ENOENT')throw error;}
}
const env={RESULTS,ASSETS:{async fetch(request){const path=new URL(request.url).pathname;if(!['/vendor/pdf.min.mjs','/vendor/pdf.worker.min.mjs'].includes(path))return new Response(null,{status:404});return new Response(await readFile(resolve('vendor',path.split('/').at(-1))));}}};
async function render(pdf,env){
 const executablePath=process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/google-chrome');
 await access(executablePath);
 return renderPDF(pdf,env,{launch:()=>puppeteer.launch({executablePath,headless:true,args:['--no-sandbox','--disable-gpu','--disable-gpu-sandbox','--disable-software-rasterizer'],userDataDir:resolve('test-artifacts/pages-chrome')})});
}
try{console.log(await updateResult(env,render));}
catch(error){
 if(!await RESULTS.get('latest.json'))throw error;
 console.warn(`Keeping the previous published result: ${error.message}`);
}
const result=await(await RESULTS.get('latest.json')).json();
for(const page of result.pages){
 const key=page.src.replace(/^\/images\//,'');
 const target=resolve(output,'images',key);await mkdir(dirname(target),{recursive:true});
 await copyFile(storedPath(key),target);
 page.src=`images/${key}`;
}
await mkdir(output,{recursive:true});
await copyFile('index.html',resolve(output,'index.html'));
await writeFile(resolve(output,'result.json'),JSON.stringify(result,null,2));
await writeFile(resolve(output,'.nojekyll'),'');
console.log(`Prepared GitHub Pages site with result ${result.date}.`);
