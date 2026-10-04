import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
export async function publishPages(directory,{token=process.env.GITHUB_TOKEN,repository=process.env.GITHUB_REPOSITORY,configure=false}={}){
 if(!token||!/^[-\w.]+\/[-\w.]+$/.test(repository||''))throw Error('GitHub publishing requires repository credentials.');
 const base=`https://api.github.com/repos/${repository}`;
 async function api(path,{method='GET',body,allow404=false}={}){
  const response=await fetch(`${base}${path}`,{method,headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
  if(response.status===404&&allow404)return null;
  if(!response.ok)throw Error(`GitHub ${method} ${path}: HTTP ${response.status}: ${await response.text()}`);
  return response.status===204?null:response.json();
 }
 const result=JSON.parse(await readFile(resolve(directory,'result.json'),'utf8'));
 if(!configure){
  const existing=await api('/contents/result.json?ref=gh-pages',{allow404:true});
  const index=await api('/contents/index.html?ref=gh-pages',{allow404:true});
  if(existing?.content&&index?.content){
   const saved=JSON.parse(Buffer.from(existing.content,'base64').toString());
   if(JSON.stringify({date:saved.date,draws:saved.draws})===JSON.stringify({date:result.date,draws:result.draws})&&Buffer.from(index.content,'base64').toString()===await readFile(resolve(directory,'index.html'),'utf8')){
    console.log('These draw results and the website are already published.');return;
   }
  }
 }
 const paths=['index.html','result.json','.nojekyll',...result.draws.flatMap(draw=>draw.result?.pages.map(page=>page.src)||[])];
 const blobs=[];
 for(const path of paths){
  if(path.startsWith('images/')&&!/^images\/results\/\d{4}-\d{2}-\d{2}\/(MN|DN|EN)\/page-\d+\.png$/.test(path))throw Error('Invalid published image path.');
  const bytes=await readFile(resolve(directory,path));const blob=await api('/git/blobs',{method:'POST',body:{content:bytes.toString('base64'),encoding:'base64'}});
  blobs.push({path,mode:'100644',type:'blob',sha:blob.sha});
 }
 const ref=await api('/git/ref/heads/gh-pages',{allow404:true});
 const tree=await api('/git/trees',{method:'POST',body:{tree:blobs}});
 const commit=await api('/git/commits',{method:'POST',body:{message:`Publish ${result.date} lottery results`,tree:tree.sha,parents:ref?[ref.object.sha]:[]}});
 if(ref)await api('/git/refs/heads/gh-pages',{method:'PATCH',body:{sha:commit.sha,force:false}});
 else await api('/git/refs',{method:'POST',body:{ref:'refs/heads/gh-pages',sha:commit.sha}});
 // Explicitly request a build: GITHUB_TOKEN pushes do not trigger Pages builds.
 if(configure)await api('/pages',{method:'PUT',body:{build_type:'legacy',source:{branch:'gh-pages',path:'/'}}});
 await api('/pages/builds',{method:'POST'});
 console.log(`Published ${result.draws.filter(draw=>draw.status==='ready').length}/3 current results to gh-pages.`);
}
