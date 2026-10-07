import fs from 'node:fs';
import {ContractFactory,JsonRpcProvider,keccak256} from 'ethers';
import {config,readJSON,writeJSON} from '../server/config.ts';
import {compile} from './compile.ts';
import type {FlowDeployment} from '../shared/flow.ts';
export async function deployFlow(){
  const url=new URL(config.localRpc);if(!['localhost','127.0.0.1'].includes(url.hostname)||url.protocol!=='http:')throw new Error('Only a loopback development chain is allowed');
  const p=new JsonRpcProvider(config.localRpc,31337,{staticNetwork:true,cacheTimeout:-1});
  try{
    if(Number(await p.send('eth_chainId',[]))!==31337)throw new Error('Wrong development chain');
    compile();const artifact=readJSON('shared/artifacts/GymToken.json'),file='data/flow/deployment-local.json';
    if(fs.existsSync(file)){const d=readJSON<FlowDeployment>(file),receipt=await p.getTransactionReceipt(d.deploymentHash),code=await p.getCode(d.token);if(receipt?.status===1&&receipt.contractAddress?.toLowerCase()===d.token.toLowerCase()&&keccak256(code)===keccak256(artifact.deployedBytecode)){console.log('Direct-flow token deployment reused');return d;}}
    const signers=await p.listAccounts();if(signers.length<5)throw new Error('Five local demo accounts required');
    const [merchant,userA,userB,payout,nextPayout]=signers;
    const token=await new ContractFactory(artifact.abi,artifact.bytecode,merchant).deploy([userA.address,userB.address],[30000,30000]);
    const receipt=await token.deploymentTransaction()!.wait();if(receipt?.status!==1)throw new Error('Deployment failed');
    const d:FlowDeployment={id:'direct-local-'+Date.now(),chainId:31337,dataOrigin:'local-chain',token:await token.getAddress(),tokenSymbol:'GYM',decimals:0,deploymentBlock:receipt.blockNumber,deploymentHash:receipt.hash,accounts:{merchant:merchant.address,userA:userA.address,userB:userB.address,payout:payout.address,nextPayout:nextPayout.address}};
    if(fs.existsSync(file))writeJSON('data/flow/archive/deployment-local-'+Date.now()+'.json',readJSON(file));
    writeJSON(file,d);console.log(JSON.stringify({workflow:'direct-flow-v1',token:d.token,chainId:d.chainId,escrow:false}));return d;
  }finally{p.destroy();}
}
if(process.argv[1]?.endsWith('deploy-flow.ts'))await deployFlow();
