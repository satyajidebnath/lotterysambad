import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import puppeteer from '@cloudflare/puppeteer/internal/puppeteer-core.js';
import {renderPDF} from '../src/render.mjs';
import {todayResult} from '../src/result.mjs';

const executablePath=process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser=await puppeteer.launch({executablePath,headless:true,args:['--disable-gpu','--disable-software-rasterizer','--disable-gpu-sandbox','--no-sandbox','--no-first-run'],userDataDir:resolve('test-artifacts/chrome')});
console.log('Local Chrome started.');
let server;
try {
 // A deterministic, valid one-page PDF exercises PDF.js without network access.
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << >> /Contents 4 0 R >>','<< /Length 26 >>\nstream\n0 0 1 rg 20 20 80 80 re f\n\nendstream'];
 let document='%PDF-1.7\n',offsets=[0];
 for(const [index,object] of objects.entries()){offsets.push(Buffer.byteLength(document));document+=`${index+1} 0 obj\n${object}\nendobj\n`;}
 const xref=Buffer.byteLength(document);
 document+=`xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 let pdf=Buffer.from(document);
 if(process.argv.includes('--live')){
  const response=await fetch(todayResult().source,{signal:AbortSignal.timeout(45000)});
  assert.equal(response.status,200);pdf=Buffer.from(await response.arrayBuffer());
 }
 const env={ASSETS:{async fetch(request){return new Response(await readFile(resolve('public',new URL(request.url).pathname.slice(1))));}}};
 // Use the production renderer and request interception with a local browser.
 const images=await renderPDF(pdf,env,{launch:async()=>({newPage:async()=>{const page=await browser.newPage();page.on('pageerror',error=>console.error('Renderer:',error.message));return page;},close:async()=>{}})});
 assert.ok(images.length>=1&&images.length<=10);
 for(const image of images){assert.equal(Buffer.from(image.bytes).subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.ok(image.width>0&&image.height>0&&image.width<=1800&&image.height<=1800);}
 await mkdir('test-artifacts',{recursive:true});await writeFile('test-artifacts/rendered-page.png',images[0].bytes);
 const today=todayResult(),result={...today,pages:images.map((image,index)=>({src:`/images/results/${today.date}/page-${index+1}.png`,width:image.width,height:image.height})),updatedAt:new Date().toISOString()};
 let mode='ok';
 server=createServer(async(request,response)=>{
  try{
   if(request.url==='/result.json'){response.setHeader('Content-Type','application/json');if(mode==='missing'){response.statusCode=503;response.end(JSON.stringify({error:'No result yet.'}));}else response.end(JSON.stringify(mode==='invalid'?{...result,pages:[]}:result));return;}
   const image=result.pages.findIndex(page=>page.src===request.url);
   if(image>=0){response.setHeader('Content-Type','image/png');response.end(images[image].bytes);return;}
   response.setHeader('Content-Type','text/html');response.end(await readFile('public/index.html'));
  }catch(error){response.statusCode=500;response.end(error.message);}
 });
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 const url=`http://127.0.0.1:${server.address().port}`;
 await page.goto(url);await page.waitForFunction(()=>document.querySelector('#status').textContent==='Today’s result');
 await page.waitForFunction(()=>document.querySelector('#pages img')?.naturalWidth>0);
 assert.equal(await page.$$eval('#pages img',images=>images.length),images.length);
 await writeFile('test-artifacts/website.png',await page.screenshot({fullPage:true}));
 // Simulate the automatic refresh without waiting a full minute.
 await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
 await new Promise(done=>setTimeout(done,150));
 assert.equal(await page.$$eval('#pages img',images=>images.length),images.length);
 mode='missing';await page.reload();await page.waitForFunction(()=>document.querySelector('#status').textContent==='No result yet.');
 mode='ok';await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
 await page.waitForFunction(()=>document.querySelector('#status').textContent==='Today’s result');
 mode='invalid';await page.reload();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('result data is invalid'));
 assert.equal(await page.$$eval('#pages img',images=>images.length),0);assert.deepEqual(errors,[]);
 console.log(`Browser check passed: ${images.length} rendered page(s), image display, refresh, recovery, invalid data.`);
}finally{if(server)await new Promise(done=>server.close(done));await browser.close();}
