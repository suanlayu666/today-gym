import {it} from 'node:test';
import assert from 'node:assert/strict';
import {automaticInvestigation} from '../server/monitor.ts';
import type {Dataset,Alert,ChainEvent,Report} from '../shared/types.ts';
// Pure scheduling fixtures. Does not call a model or send transactions.
const ds={id:'gym',adapter:'gym'} as Dataset,cp={status:'ok',coverageComplete:true,blockNumber:10,timestamp:100};
const events=[{blockNumber:8}] as ChainEvent[],alerts=[{severity:'attention',ruleId:'R1',evidenceIds:['e1'],window:{from:0,to:101}}] as Alert[];
it('background investigation only triggers eligible gym changes, never failed data, no alerts or mainnet',()=>{
  assert.ok(automaticInvestigation(ds,cp,events,alerts,[],[],true));
  for(const [d,c,a,enabled] of [[ds,cp,alerts,false],[{...ds,adapter:'erc20'},cp,alerts,true],[ds,{...cp,status:'error'},alerts,true],[ds,cp,[],true],[ds,cp,[{...alerts[0],severity:'info'}],true],[ds,{...cp,timestamp:102},alerts,true]] as any[])assert.equal(automaticInvestigation(d,c,events,a,[],[],enabled),undefined);
});
it('completed coverage, active work, persistent key and cooldown prevent repeated background billing',()=>{
  const run=automaticInvestigation(ds,cp,events,alerts,[],[],true)!;
  const report={datasetId:'gym',status:'complete',mode:'llm',asOfBlock:8} as Report;
  assert.equal(automaticInvestigation(ds,cp,events,alerts,[report],[],true),undefined);
  for(const jobs of [[{status:'running'}],[{status:'partial',automaticKey:run.automaticKey}],[{status:'complete',automaticKey:'another',createdAt:new Date().toISOString()}]])assert.equal(automaticInvestigation(ds,cp,events,alerts,[],jobs,true),undefined);
  assert.ok(automaticInvestigation(ds,cp,events,alerts,[{...report,status:'partial'}],[],true));
});
