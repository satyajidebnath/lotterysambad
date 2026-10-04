import puppeteer from '@cloudflare/puppeteer';
import {Buffer} from 'node:buffer';
export async function renderPDF(pdf,env,{launch=puppeteer.launch.bind(puppeteer)}={}) {
 const browser=await launch(env.BROWSER);
 let timeout;
 try {
  const page=await browser.newPage();page.setDefaultTimeout(90000);
  await page.setRequestInterception(true);
  page.on('request',request=>{
   (async()=>{
    const url=new URL(request.url());
    if(url.hostname!=='renderer.invalid')return request.abort();
    if(url.pathname==='/')return request.respond({status:200,contentType:'text/html',body:'<!doctype html><html><body></body></html>'});
    if(url.pathname==='/source.pdf')return request.respond({status:200,contentType:'application/pdf',body:Buffer.from(pdf)});
    if(!['/vendor/pdf.min.mjs','/vendor/pdf.worker.min.mjs'].includes(url.pathname))return request.abort();
    const asset=await env.ASSETS.fetch(new Request(`https://assets.local${url.pathname}`));
    if(!asset.ok)throw Error('Missing PDF.js asset.');
    return request.respond({status:200,contentType:'text/javascript',body:Buffer.from(await asset.arrayBuffer())});
   })().catch(error=>{console.error(error.message);request.abort().catch(()=>{});});
  });
  await page.goto('https://renderer.invalid/',{waitUntil:'domcontentloaded'});
  const rendering=page.evaluate(async(vendorBase)=>{
   const pdfjs=await import(vendorBase+'/pdf.min.mjs');
   // Disable a real browser worker by preloading its handler: all requests remain
   // inside this intercepted page instead of an unobserved worker target.
   const worker=await import(vendorBase+'/pdf.worker.min.mjs');
   globalThis.pdfjsWorker={WorkerMessageHandler:worker.WorkerMessageHandler};
   const data=new Uint8Array(await(await fetch('/source.pdf')).arrayBuffer());
   const doc=await pdfjs.getDocument({data,isEvalSupported:false}).promise;
   const output=[];
   try {
    if(doc.numPages>10)throw Error('PDF exceeds 10 page limit.');
    for(let number=1;number<=doc.numPages;number++) {
     const page=await doc.getPage(number),original=page.getViewport({scale:1});
     const viewport=page.getViewport({scale:1800/Math.max(original.width,original.height)});
     const canvas=document.createElement('canvas');canvas.width=Math.min(1800,Math.ceil(viewport.width));canvas.height=Math.min(1800,Math.ceil(viewport.height));
     await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
     output.push({width:canvas.width,height:canvas.height,base64:canvas.toDataURL('image/png').split(',')[1]});
     page.cleanup();canvas.width=canvas.height=0;
    }
   }finally{await doc.destroy();}
   return output;
  },'/vendor');
  const images=await Promise.race([rendering,new Promise((_,reject)=>{
   timeout=setTimeout(()=>reject(Error('PDF conversion exceeded 120 seconds.')),120000);
  })]);
  return images.map(image=>({width:image.width,height:image.height,bytes:Buffer.from(image.base64,'base64')}));
 }finally{clearTimeout(timeout);await browser.close();}
}
