import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {config,writeJSON} from '../server/config.ts';
import {Store} from '../server/store.ts';
import {reportMarkdown} from '../server/agent.ts';
import type {Dataset,Report} from '../shared/types.ts';

const root=`http://127.0.0.1:${config.port}`,checks:{name:string;passed:boolean;details?:unknown}[]=[],store=new Store();
const check=async(name:string,fn:()=>unknown)=>{const details=await fn();checks.push({name,passed:true,...(details===undefined?{}:{details})});};
async function request(endpoint:string,init?:RequestInit){const r=await fetch(root+'/api'+endpoint,{...init,signal:AbortSignal.timeout(20000)});const text=await r.text();assert.ok(!config.llmKey||!text.includes(config.llmKey),'API exposed actual model credential');return {r,text};}
try{
  await check('health and config contain public fields, not credentials',async()=>{for(const endpoint of ['/health','/config']){const {r,text}=await request(endpoint);assert.equal(r.status,200);const b=JSON.parse(text);assert.ok(b.data);assert.ok(!/privateKey|llmKey|DEEPSEEK_API_KEY/.test(text));}});
  await check('unknown browser Origin rejected',async()=>{const {r}=await request('/config',{headers:{Origin:'https://untrusted.invalid'}});assert.equal(r.status,403);});
  await check('DNS-rebinding/unknown Host rejected',async()=>{
    // Node fetch rewrites Host; send an actual HTTP Host header instead of testing
    // a request that silently remained localhost.
    const status=await new Promise<number|undefined>((resolve,reject)=>{const req=http.request(root+'/api/config',{headers:{Host:'untrusted.invalid:3001'}},res=>{res.resume();resolve(res.statusCode);});req.setTimeout(5000,()=>req.destroy(new Error('Host probe timeout')));req.on('error',reject);req.end();});assert.equal(status,403);
  });
  await check('local browser Origin permitted',async()=>{const {r}=await request('/config',{headers:{Origin:'http://127.0.0.1:5173'}});assert.equal(r.status,200);});
  await check('invalid dataset rejected, not silently substituted',async()=>{const {r}=await request('/overview?datasetId=not-a-case');assert.equal(r.status,400);});
  await check('invalid user address rejected',async()=>{const ds=store.list<Dataset>('datasets').find(d=>d.adapter==='gym')!;const {r}=await request('/users/not-an-address?datasetId='+ds.id);assert.equal(r.status,400);});
  await check('malformed JSON and oversized body rejected',async()=>{for(const body of ['{',JSON.stringify({question:'x'.repeat(70000)})]){const {r}=await request('/investigations',{method:'POST',headers:{'Content-Type':'application/json'},body});assert.equal(r.status,400);}});
  await check('unknown signing/API operation is unavailable',async()=>{const {r}=await request('/sign',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'eth_sendTransaction'})});assert.equal(r.status,404);});
  await check('empty question and arbitrary URL argument rejected before task creation',async()=>{const ds=store.list<Dataset>('datasets')[0];for(const input of [{datasetId:ds.id,question:''},{datasetId:ds.id,question:'unit input validation',url:'https://untrusted.invalid'}]){const {r}=await request('/investigations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});assert.equal(r.status,400);}});
  for(const ds of store.list<Dataset>('datasets')){
    await check(ds.id+': overview network and mainnet read-only data separation',async()=>{const {r,text}=await request('/overview?datasetId='+ds.id);assert.equal(r.status,200);const o=JSON.parse(text).data;assert.equal(o.dataset.chainId,ds.chainId);if(ds.adapter==='erc20')assert.equal(o.snapshot,null);assert.ok(o.events.every((e:any)=>e.datasetId===ds.id&&e.chainId===ds.chainId));});
    const report=store.list<Report>('reports',ds.id).find(r=>r.status==='complete'&&r.mode==='llm');if(!report)continue;
    await check(ds.id+': JSON/Markdown export match persisted report',async()=>{
      const j=await request('/reports/'+report.id+'/export?format=json');assert.equal(j.r.status,200);assert.match(j.r.headers.get('content-disposition')||'',/^attachment;/);assert.deepEqual(JSON.parse(j.text).data,report);
      const m=await request('/reports/'+report.id+'/export?format=md');assert.equal(m.r.status,200);assert.equal(m.text,reportMarkdown(report));assert.match(m.r.headers.get('content-type')||'',/text\/markdown/);
    });
    await check(ds.id+': report references resolve through actual evidence API',async()=>{const ids=Array.from(new Set(report.findings.flatMap(f=>f.evidenceIds)));for(const id of ids){const {r,text}=await request('/evidence/'+id);assert.equal(r.status,200);const e=JSON.parse(text).data;assert.equal(e.datasetId,ds.id);assert.equal(e.chainId,ds.chainId);assert.ok(e.asOfBlock<=report.asOfBlock);}return {references:ids.length};});
  }
  await check('built browser bundle excludes actual model/test-wallet credentials',()=>{
    const privateFile='.runtime/sepolia-wallets.json',wallets=fs.existsSync(privateFile)?JSON.parse(fs.readFileSync(privateFile,'utf8')):null;
    const secrets=[config.llmKey,...Object.values(wallets?.accounts??{}).map((w:any)=>w.privateKey)].filter((s):s is string=>typeof s==='string'&&s.length>10);
    let files=0;const scan=(dir:string)=>{for(const item of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,item.name);if(item.isDirectory())scan(p);else {const bytes=fs.readFileSync(p);for(const secret of secrets)assert.ok(!bytes.includes(Buffer.from(secret)),'Credential found in built browser output');files++;}}};scan('dist/web');return {scannedBuiltFiles:files};
  });
  console.log(JSON.stringify({passed:true,checks:checks.length}));
}catch(error){checks.push({name:'API verification halted',passed:false,details:error instanceof Error?error.message:'Unknown'});console.error(JSON.stringify(checks.at(-1)));process.exitCode=1;}
finally{writeJSON('artifacts/acceptance/api-results.json',{at:new Date().toISOString(),checks,scope:'Actual loopback API and built browser files; not a penetration test or public deployment security certification.'});store.close();}
