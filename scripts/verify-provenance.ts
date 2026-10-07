import assert from 'node:assert/strict';
import {writeJSON} from '../server/config.ts';

async function api(path:string,body?:unknown){const r=await fetch('http://127.0.0.1:3001/api'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(45000)});assert.ok(r.ok);return (await r.json()).data;}
const results:any[]=[];
try{
  const {datasets}=await api('/config');
  for(const ds of datasets.filter((d:any)=>d.chainId===1&&d.toBlock!==undefined)){
    const before=await api('/overview?datasetId='+encodeURIComponent(ds.id));const after=await api('/sync',{datasetId:ds.id});
    assert.equal(after.status,'ok');assert.equal(after.blockNumber,before.checkpoint.blockNumber);assert.equal(after.blockHash,before.checkpoint.blockHash);
    assert.equal(after.coverageMethod,before.checkpoint.coverageMethod);assert.equal(after.replay,true);assert.equal(after.capturedAt,ds.collection.capturedAt);assert.match(after.refreshMethod,/不代表重新全量/);
    const refreshed=await api('/overview?datasetId='+encodeURIComponent(ds.id));assert.equal(refreshed.totalEventCount,before.totalEventCount);assert.equal(refreshed.dataset.collection.capturedAt,ds.collection.capturedAt);
    results.push({datasetId:ds.id,status:'pass',savedEvents:refreshed.totalEventCount,checkpoint:after});
  }
  assert.equal(results.length,2);console.log(JSON.stringify({passed:true,datasets:results.length}));
}catch(error){results.push({status:'fail',message:error instanceof Error?error.message:'Unknown'});process.exitCode=1;console.error(JSON.stringify(results.at(-1)));}
finally{writeJSON('artifacts/acceptance/manual-sync-provenance.json',{at:new Date().toISOString(),results,scope:'实际手动同步核对：保存窗口的采集时间与索引来源不被误标为本次全量重采'});}
