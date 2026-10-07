import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JsonRpcProvider} from 'ethers';
import {config,readJSON,writeJSON} from '../server/config.ts';
import type {Dataset} from '../shared/types.ts';

// Synchronize after local snapshot tests, before exercising API state queries.
// No signing or transactions. Verify the returned checkpoint is canonical,
// including when the API already has an automatic sync in progress.
const provider=new JsonRpcProvider(config.localRpc,31337,{staticNetwork:true,cacheTimeout:-1});
const results:unknown[]=[];
try{
  assert.equal(Number(await provider.send('eth_chainId',[])),31337);
  for(const file of ['data/deployments/local.json','data/deployments/local-anomaly.json']){
    if(!fs.existsSync(file))continue;
    const ds=readJSON<Dataset>(file);assert.equal(ds.chainId,31337);
    let verified=false;
    for(let attempt=0;attempt<4;attempt++){
      const response=await fetch('http://127.0.0.1:'+config.port+'/api/sync',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({datasetId:ds.id}),signal:AbortSignal.timeout(10000)
      });
      assert.equal(response.status,200);
      const {data:checkpoint}=await response.json() as {data:any};
      const head=await provider.getBlockNumber();
      const block=checkpoint?.blockNumber!==undefined&&checkpoint.blockNumber<=head?await provider.getBlock(checkpoint.blockNumber):null;
      if(checkpoint?.status==='ok'&&checkpoint.coverageComplete&&checkpoint.blockNumber===head&&block?.hash===checkpoint.blockHash){
        results.push({datasetId:ds.id,blockNumber:head,blockHash:block!.hash,attempts:attempt+1});verified=true;break;
      }
      await new Promise(resolve=>setTimeout(resolve,300));
    }
    assert.ok(verified,'Local API checkpoint did not recover to canonical head: '+ds.id);
  }
  assert.ok(results.length,'No local deployments to verify');
  writeJSON('artifacts/acceptance/local-sync-recovery.json',{at:new Date().toISOString(),passed:true,results,scope:'Actual local RPC/API post-snapshot synchronization; no new business or public transactions.'});
  console.log(JSON.stringify({passed:true,datasets:results.length}));
}finally{provider.destroy();}
