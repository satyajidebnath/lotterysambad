import {DRAWS,indiaDateParts} from './draws.mjs';
import {firstPrize} from './prize.mjs';
export function todayResult(date=new Date(),draw='MN') {
 if(!DRAWS.some(item=>item.id===draw))throw Error('Unknown draw.');
 const parts=indiaDateParts(date),filename=`${draw}${parts.stamp}.PDF`;
 return {date:parts.date,draw,filename,source:`https://www.lotterysambad.com/fetchtoday.php?filename=${filename}`};
}
const MAX_PDF_BYTES=20*1024*1024;
async function readPDF(response) {
 if(Number(response.headers.get('Content-Length'))>MAX_PDF_BYTES){
  await response.body?.cancel();throw Error('PDF exceeds 20 MB limit.');
 }
 if(!response.body)throw Error('PDF source returned an empty body.');
 const reader=response.body.getReader(),chunks=[];let length=0;
 try {
  while(true){
   const {done,value}=await reader.read();if(done)break;
   length+=value.byteLength;
   if(length>MAX_PDF_BYTES){await reader.cancel();throw Error('PDF exceeds 20 MB limit.');}
   chunks.push(value);
  }
 }finally{reader.releaseLock();}
 const pdf=new Uint8Array(length);let offset=0;
 for(const chunk of chunks){pdf.set(chunk,offset);offset+=chunk.byteLength;}
 return pdf.buffer;
}
function validatePDF(pdf) {
 if(pdf.byteLength>MAX_PDF_BYTES)throw Error('PDF exceeds 20 MB limit.');
 if(!new TextDecoder().decode(pdf.slice(0,1024)).includes('%PDF-'))throw Error("Today's PDF is not published yet.");
}
export async function updateResult(env,render,date=new Date(),draw='MN') {
 const today=todayResult(date,draw),prefix=`results/${today.date}/${draw}`,key=`${prefix}/result.json`;
 const complete=await env.RESULTS.get(key);
 if(complete){
  const result=await complete.json();
  await env.RESULTS.put(`latest-${draw}.json`,JSON.stringify(result),{httpMetadata:{contentType:'application/json'}});
  return {status:'cached',date:today.date};
 }
 const pdfKey=`${prefix}/${today.filename}`;
 const saved=await env.RESULTS.get(pdfKey);let pdf;
 if(saved)pdf=await saved.arrayBuffer();
 else {
  const response=await fetch(today.source,{signal:AbortSignal.timeout(45000)});
  if(!response.ok){await response.body?.cancel();throw Error(`PDF source returned HTTP ${response.status}`);}
  pdf=await readPDF(response);
  validatePDF(pdf);
  await env.RESULTS.put(pdfKey,pdf,{httpMetadata:{contentType:'application/pdf'}});
 }
 validatePDF(pdf);
 const images=await render(pdf,env);
 if(!Array.isArray(images)||!images.length)throw Error('The PDF contains no pages.');
 if(images.length>10)throw Error('PDF exceeds 10 page limit.');
 for(const image of images){
  if(!image.bytes?.byteLength||!Number.isInteger(image.width)||!Number.isInteger(image.height)||image.width<1||image.height<1||image.width>1800||image.height>1800)throw Error('Renderer returned an invalid page.');
 }
 const pages=[];
 for(const [index,image] of images.entries()) {
  const imageKey=`${prefix}/page-${index+1}.png`;
  await env.RESULTS.put(imageKey,image.bytes,{httpMetadata:{contentType:'image/png',cacheControl:'public, max-age=31536000, immutable'}});
  pages.push({src:`/images/${imageKey}`,width:image.width,height:image.height});
 }
 const result={...today,pages,imageFormat:'trimmed-v1',firstPrize:firstPrize(images),updatedAt:new Date().toISOString()};
 // Publish only after every image is stored.
 await env.RESULTS.put(key,JSON.stringify(result),{httpMetadata:{contentType:'application/json'}});
 await env.RESULTS.put(`latest-${draw}.json`,JSON.stringify(result),{httpMetadata:{contentType:'application/json'}});
 return {status:'updated',date:today.date,pages:pages.length};
}
export async function updateAllResults(env,render,date=new Date()){
 const india=indiaDateParts(date),draws=[],updates=[];
 for(const draw of DRAWS){
  const due=india.time>=draw.downloadTime;
  let error;
  if(due){
   try{updates.push({draw:draw.id,...await updateResult(env,render,date,draw.id)});}
   catch(failure){error=failure.message;updates.push({draw:draw.id,status:'pending',error});console.warn(`${draw.id}: ${error}`);}
  }else updates.push({draw:draw.id,status:'scheduled'});
  const saved=await env.RESULTS.get(`latest-${draw.id}.json`),result=saved?await saved.json():null;
  draws.push({...draw,status:result?.date===india.date?'ready':due?'pending':'scheduled',result});
 }
 const manifest={date:india.date,timeZone:'Asia/Kolkata',draws,updatedAt:date.toISOString()};
 await env.RESULTS.put('latest.json',JSON.stringify(manifest),{httpMetadata:{contentType:'application/json'}});
 return {status:updates.some(item=>item.status==='updated')?'updated':'cached',date:india.date,updates};
}
