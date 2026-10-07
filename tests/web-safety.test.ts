import {it} from 'node:test';
import assert from 'node:assert/strict';
import {walletError,writeReady,assertIdentity} from '../web/src/safety.ts';
// Pure mock inputs; does not claim an actual injected wallet rejection.
it('rejected signatures: direct and wrapped 4001 and ethers ACTION_REJECTED',()=>{
  for(const error of [{code:4001},{info:{error:{code:4001}}},{code:'ACTION_REJECTED'}])assert.equal(walletError(error),'已拒绝签名，未发送此笔交易。');
  assert.equal(walletError({message:'RPC unavailable'}),'RPC unavailable');
});
it('no writes on unknown balances, failed config/data, incomplete index, wrong network or mainnet',()=>{
  const ready={account:'0xabc',adapter:'gym',chainId:31337,walletChain:31337,dataError:'',configError:'',user:{balance:'0'},checkpoint:{status:'ok',coverageComplete:true}};
  assert.equal(writeReady(ready),true);
  for(const changes of [{user:undefined},{dataError:'failed'},{configError:'failed'},{checkpoint:{status:'error',coverageComplete:false}},{walletChain:11155111},{adapter:'erc20',chainId:1,walletChain:1}])assert.equal(writeReady({...ready,...changes}),false);
});
it('account/dataset changes abort stale transactions, including after approval',()=>{
  const current={datasetId:'new',account:'0xabc'};assert.throws(()=>assertIdentity(current,'old','0xabc'));assert.throws(()=>assertIdentity(current,'new','0xdef'));assertIdentity(current,'new','0xABC');
});
