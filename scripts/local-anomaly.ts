import assert from 'node:assert/strict';
import {id} from 'ethers';
import {deployLocal} from './deploy.ts';
import {writeJSON} from '../server/config.ts';
import {Store} from '../server/store.ts';
import {ChainService} from '../server/chain.ts';
import type {Dataset} from '../shared/types.ts';

const f=await deployLocal(false),transactions:{step:string;txHash:string;blockNumber:number}[]=[];
const send=async(step:string,request:Promise<any>)=>{const tx=await request,r=await tx.wait();assert.equal(r.status,1);transactions.push({step,txHash:r.hash,blockNumber:r.blockNumber});};
try{
  const user=f.accounts[1];await send('approve',f.token.connect(user).approve(f.manifest.escrow,3000));await send('deposit',f.escrow.connect(user).deposit(3000));
  for(let i=0;i<24;i++){const n=await f.escrow.nextRequestId();await send(`request-${i+1}`,f.escrow.requestConsumption(user.address,id('controlled-local-session-'+i)));await send(`confirm-${i+1}`,f.escrow.connect(user).confirmConsumption(n));}
  assert.equal(await f.escrow.merchantAvailable(),720n);await send('payout-change',f.escrow.setPayoutAddress(f.manifest.nextPayout));await send('withdraw-600',f.escrow.withdraw(600));
  assert.equal(await f.escrow.balances(user.address),2280n);assert.equal(await f.escrow.merchantAvailable(),120n);assert.equal(await f.token.balanceOf(f.manifest.nextPayout),600n);
  const manifest:Dataset={...f.manifest,id:`local-anomaly-${transactions.at(-1)!.blockNumber}`,name:'本地异动 · 密集核销与改址提现',adapter:'gym',dataOrigin:'local-chain',caseRole:'anomaly'};
  writeJSON('data/deployments/local-anomaly.json',manifest);const store=new Store();try{store.put('datasets',manifest);const sync=await new ChainService(store).sync(manifest);assert.equal(sync.coverageComplete,true);const alerts=store.list('alerts',manifest.id);assert.ok(['R1','R2','R4'].every(rule=>alerts.some(a=>a.ruleId===rule)));writeJSON('artifacts/acceptance/local-anomaly.json',{dataset:manifest,transactions,alerts,accounting:{assets:'2400',userCredit:'2280',revenue:'120'},verifiedAt:new Date().toISOString(),limitation:'人为构造的真实本地 EVM 交易，不是公开网络或真实经营诈骗。'});console.log(JSON.stringify({datasetId:manifest.id,transactions:transactions.length,rules:alerts.map(a=>a.ruleId),withdrawal:'600',denominator:'720',remainingCredit:'2280'}));}finally{store.close();}
}finally{f.provider.destroy();}
