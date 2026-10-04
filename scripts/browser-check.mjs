import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {createServer} from 'node:http';
import puppeteer from '@cloudflare/puppeteer/internal/puppeteer-core.js';
const root=resolve('.site'),manifest=JSON.parse(await readFile(resolve(root,'result.json'),'utf8'));
let mode='ok';
const base='/lotterysambad/';
const server=createServer(async(request,response)=>{
 try{
  const path=new URL(request.url,'http://localhost').pathname;
  if(!path.startsWith(base)){response.statusCode=404;response.end('Not found');return;}
  const relative=path.slice(base.length)||'index.html';
  if(relative==='result.json'){
   response.setHeader('Content-Type','application/json');
   if(mode==='missing'){response.statusCode=503;response.end('{}');return;}
   const data=structuredClone(manifest);
   if(mode==='pending'){data.draws[1].result=null;data.draws[1].status='pending';}
   if(mode==='invalid')data.draws[0].result.pages[0].src='https://example.com/unsafe.png';
   response.end(JSON.stringify(data));return;
  }
  const target=resolve(root,relative);
  if(!target.startsWith(root+sep)){response.statusCode=404;response.end();return;}
  response.setHeader('Content-Type',relative.endsWith('.png')?'image/png':'text/html');response.end(await readFile(target));
 }catch(error){response.statusCode=404;response.end(error.message);}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
let browser;
try{
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--no-sandbox','--disable-gpu','--disable-software-rasterizer','--disable-gpu-sandbox'],userDataDir:resolve('test-artifacts/design-chrome')});
 const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.setViewport({width:1280,height:900});
 await page.goto(`http://127.0.0.1:${server.address().port}${base}`);
 await page.waitForFunction(()=>document.querySelectorAll('.preview img').length===3&&[...document.querySelectorAll('.preview img')].every(img=>img.naturalWidth>0));
 assert.equal(await page.$$eval('.card',cards=>cards.length),3);
 assert.equal(await page.$$eval('a',links=>links.length),0);
 assert.ok((await page.$eval('#times',el=>el.textContent)).includes('1:10 PM'));
 await mkdir('test-artifacts',{recursive:true});await writeFile('test-artifacts/website.png',await page.screenshot({fullPage:true}));
 await page.click('.preview');await page.waitForFunction(()=>document.querySelector('#viewer').open);
 await page.waitForFunction(()=>document.querySelector('#full-pages img').naturalWidth>0);await page.keyboard.press('Escape');assert.equal(await page.$eval('#viewer',el=>el.open),false);
 await page.click('#refresh');await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);assert.equal(await page.$$eval('.card',cards=>cards.length),3);
 mode='pending';await page.click('#refresh');await page.waitForFunction(()=>document.querySelector('[data-draw="DN"] .placeholder strong')?.textContent==='PDF not available yet');
 assert.equal(await page.$$eval('.preview img',images=>images.length),2);
 mode='ok';await page.click('#refresh');await page.waitForFunction(()=>document.querySelectorAll('.preview img').length===3);
 await page.setViewport({width:390,height:844});await writeFile('test-artifacts/mobile.png',await page.screenshot({fullPage:true}));
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 mode='missing';await page.click('#refresh');await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Showing the saved results.'));assert.equal(await page.$$eval('.preview img',images=>images.length),3);
 mode='invalid';await page.reload();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('result data is invalid'));assert.equal(await page.$$eval('.preview img',images=>images.length),0);
 assert.deepEqual(errors,[]);console.log('Browser check passed: three real PDFs, project paths, compact layout, mobile, zoom, pending messages, refresh and invalid data.');
}finally{if(browser)await browser.close();await new Promise(done=>server.close(done));}
