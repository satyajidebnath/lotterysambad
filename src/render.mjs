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
     // Match the published result sheet by removing blank PDF page margins.
     const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
     let left=canvas.width,top=canvas.height,right=-1,bottom=-1;
     for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
      const offset=(y*canvas.width+x)*4;
      if(pixels[offset+3]>0&&(pixels[offset]<245||pixels[offset+1]<245||pixels[offset+2]<245)){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);}
     }
     const sheet=document.createElement('canvas');sheet.width=right>=left?right-left+1:canvas.width;sheet.height=bottom>=top?bottom-top+1:canvas.height;
     sheet.getContext('2d').drawImage(canvas,right>=left?left:0,bottom>=top?top:0,sheet.width,sheet.height,0,0,sheet.width,sheet.height);
     const text=(await page.getTextContent()).items.map(item=>item.str).join(' ');
     output.push({width:sheet.width,height:sheet.height,text,base64:sheet.toDataURL('image/png').split(',')[1]});
     page.cleanup();canvas.width=canvas.height=sheet.width=sheet.height=0;
    }
   }finally{await doc.destroy();}
   return output;
  },'/vendor');
  const images=await Promise.race([rendering,new Promise((_,reject)=>{
   timeout=setTimeout(()=>reject(Error('PDF conversion exceeded 120 seconds.')),120000);
  })]);
  return images.map(image=>({width:image.width,height:image.height,text:image.text,bytes:Buffer.from(image.base64,'base64')}));
 }finally{clearTimeout(timeout);await browser.close();}
}
