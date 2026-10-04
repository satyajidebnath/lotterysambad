import {updateResult} from './result.mjs';
import {renderPDF} from './render.mjs';
function updater(env){return env.UPDATER.get(env.UPDATER.idFromName('daily-result'));}
export class ResultUpdater {
 constructor(ctx,env){this.env=env;this.pending=null;}
 async fetch(){
  if(!this.pending)this.pending=updateResult(this.env,renderPDF).finally(()=>{this.pending=null;});
  try{return Response.json(await this.pending);}
  catch(error){console.error(error);return Response.json({error:error.message},{status:502});}
 }
}
export default {
 async scheduled(event,env,ctx){
  ctx.waitUntil((async()=>{
   const response=await updater(env).fetch('https://updater.internal/update');
   if(!response.ok)throw Error(await response.text());
   console.log(await response.text());
  })());
 },
 async fetch(request,env,ctx){
  const url=new URL(request.url);
  if(url.pathname==='/admin/update'){
   if(request.method!=='POST')return new Response('Use POST',{status:405,headers:{Allow:'POST'}});
   if(!env.ADMIN_TOKEN||request.headers.get('Authorization')!==`Bearer ${env.ADMIN_TOKEN}`)return new Response('Unauthorized',{status:401});
   return updater(env).fetch('https://updater.internal/update');
  }
  if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405,headers:{Allow:'GET, HEAD'}});
  if(url.pathname==='/result.json'){
   const latest=await env.RESULTS.get('latest.json');
   if(!latest)return new Response(request.method==='HEAD'?null:JSON.stringify({error:'No result is available yet. Please check again shortly.'}),{status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Retry-After':'60'}});
   return new Response(request.method==='HEAD'?null:latest.body,{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  }
  if(url.pathname.startsWith('/images/')){
   const key=url.pathname.slice('/images/'.length);
   if(!/^results\/\d{4}-\d{2}-\d{2}\/page-\d+\.png$/.test(key))return new Response('Not found',{status:404});
   const cache=caches.default,cacheKey=new Request(url.toString(),{method:'GET'});
   const cached=await cache.match(cacheKey);
   if(cached)return imageResponse(request,cached);
   const image=await env.RESULTS.get(key);if(!image)return new Response('Not found',{status:404});
   const headers=new Headers();image.writeHttpMetadata(headers);headers.set('ETag',image.httpEtag);
   const response=new Response(image.body,{headers});
   // HEAD requests should not read and cache an entire image.
   if(request.method==='GET')ctx.waitUntil(cache.put(cacheKey,response.clone()));
   return imageResponse(request,response);
  }
  return env.ASSETS.fetch(request);
 }
};
function imageResponse(request,response){
 const etag=response.headers.get('ETag'),condition=request.headers.get('If-None-Match');
 if(condition&&(condition.trim()==='*'||condition.split(',').some(value=>value.trim().replace(/^W\//,'')===etag))){
  return new Response(null,{status:304,headers:response.headers});
 }
 return request.method==='HEAD'?new Response(null,{status:response.status,headers:response.headers}):response;
}
