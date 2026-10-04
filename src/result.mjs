export function todayResult(date=new Date()) {
 const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
 const get=t=>parts.find(p=>p.type===t).value;
 const filename=`MN${get('day')}${get('month')}${get('year').slice(-2)}.PDF`;
 return {date:`${get('year')}-${get('month')}-${get('day')}`,filename,source:`https://www.lotterysambad.com/fetchtoday.php?filename=${filename}`};
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
export async function updateResult(env,render,date=new Date()) {
 const today=todayResult(date),key=`results/${today.date}/result.json`;
 const complete=await env.RESULTS.get(key);
 if(complete){
  const result=await complete.json();
  await env.RESULTS.put('latest.json',JSON.stringify(result),{httpMetadata:{contentType:'application/json'}});
  return {status:'cached',date:today.date};
 }
 const pdfKey=`results/${today.date}/${today.filename}`;
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
  const imageKey=`results/${today.date}/page-${index+1}.png`;
  await env.RESULTS.put(imageKey,image.bytes,{httpMetadata:{contentType:'image/png',cacheControl:'public, max-age=31536000, immutable'}});
  pages.push({src:`/images/${imageKey}`,width:image.width,height:image.height});
 }
 const result={...today,pages,updatedAt:new Date().toISOString()};
 // Publish only after every image is stored.
 await env.RESULTS.put(key,JSON.stringify(result),{httpMetadata:{contentType:'application/json'}});
 await env.RESULTS.put('latest.json',JSON.stringify(result),{httpMetadata:{contentType:'application/json'}});
 return {status:'updated',date:today.date,pages:pages.length};
}
