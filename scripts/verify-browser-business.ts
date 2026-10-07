import assert from 'node:assert/strict';
import {Contract,JsonRpcProvider,Interface} from 'ethers';
import {readJSON,writeJSON,config} from '../server/config.ts';

// Hashes were observed after actual browser clicks, not generated test fixtures.
const observed=[
  {name:'ConsumptionRequested',id:'2',hash:'0x57af34fa8b649176834bb95264714ec3e55830763ddf1bb77b9d333f6523068d'},
  {name:'ConsumptionRejected',id:'2',hash:'0x4dab030921135f23288f32dfff27ca3a335730bcfe260e2bc72db7afa2e2a818'},
  {name:'ConsumptionRequested',id:'3',hash:'0x999f27184e21a049349a718dd7a97143b20658d55ab3b7b42c843e2566b025c3'},
  {name:'ConsumptionCancelled',id:'3',hash:'0x870ccc2a00be76d3e57902aaf7244ed303bbee5cf7d8b8428ef2c71d32ebe323'},
];
const ds=readJSON('data/deployments/local.json'),abi=readJSON('shared/artifacts/GymEscrow.json').abi,p=new JsonRpcProvider(config.localRpc,31337,{cacheTimeout:-1});
try{
  assert.equal(Number(await p.send('eth_chainId',[])),31337);
  const c=new Contract(ds.escrow,abi,p),iface=new Interface(abi),receipts=[];
  for(const item of observed){const r=await p.getTransactionReceipt(item.hash);assert.equal(r?.status,1);assert.equal(r.to?.toLowerCase(),ds.escrow.toLowerCase());const ev=r.logs.filter(l=>l.address.toLowerCase()===ds.escrow.toLowerCase()).map(l=>iface.parseLog(l)).find(e=>e?.name===item.name);assert.ok(ev);assert.equal(String(ev.args.id),item.id);assert.equal(String(ev.args.user).toLowerCase(),ds.users[0].toLowerCase());receipts.push({observed:item,receipt:r.toJSON()});}
  const block=await p.getBlockNumber(),opts={blockTag:block},[rejected,cancelled,balance,active,a]=await Promise.all([c.requests(2,opts),c.requests(3,opts),c.balances(ds.users[0],opts),c.activeRequest(ds.users[0],opts),c.getAccounting(opts)]);
  assert.equal(Number(rejected.status),3);assert.equal(Number(cancelled.status),4);assert.equal(balance,2940n);assert.equal(active,0n);assert.equal(a.userCredit,2940n);assert.equal(a.revenue,0n);assert.equal(a.assets,2940n);
  writeJSON('artifacts/acceptance/browser-reject-cancel.json',{at:new Date().toISOString(),network:'actual local EVM, not public Ethereum',datasetId:ds.id,block,receipts,balance,active,accounting:{assets:a.assets,userCredit:a.userCredit,revenue:a.revenue},passed:true});
  console.log(JSON.stringify({passed:true,receipts:receipts.length,balance:String(balance),merchantRevenue:String(a.revenue),block}));
}finally{p.destroy();}
