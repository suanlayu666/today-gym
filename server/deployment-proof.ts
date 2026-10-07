import {Contract,keccak256} from 'ethers';
import {providerFor,tokenAbi} from './chain.ts';
import {readJSON} from './config.ts';
import type {Dataset} from '../shared/types.ts';

export function runtimeMatches(actual:string,artifact:{deployedBytecode:string;immutableReferences?:Record<string,{start:number;length:number}[]>}){
  if(actual==='0x'||actual.length!==artifact.deployedBytecode.length)return false;
  let normalized=actual.slice(2).toLowerCase();for(const refs of Object.values(artifact.immutableReferences||{}))for(const r of refs){const begin=r.start*2,end=begin+r.length*2;if(begin<0||end>normalized.length)return false;normalized=normalized.slice(0,begin)+'0'.repeat(r.length*2)+normalized.slice(end);}
  return normalized===artifact.deployedBytecode.slice(2).toLowerCase();
}
export async function deploymentProof(ds:Dataset){
  if(ds.adapter!=='gym'||!ds.escrow)throw new Error('Gym deployment required');const p=providerFor(ds);
  try{if(Number(await p.send('eth_chainId',[]))!==ds.chainId)throw new Error('Network mismatch');const block=await p.getBlockNumber(),token=readJSON('shared/artifacts/GymToken.json'),escrow=readJSON('shared/artifacts/GymEscrow.json');const [tokenCode,escrowCode]=await Promise.all([p.getCode(ds.token,block),p.getCode(ds.escrow,block)]);
    if(!runtimeMatches(tokenCode,token)||!runtimeMatches(escrowCode,escrow))throw new Error('Deployed runtime differs from compiled artifact');
    const c=new Contract(ds.escrow,escrow.abi,p),t=new Contract(ds.token,tokenAbi,p);const [boundToken,merchant,decimals]=await Promise.all([c.token({blockTag:block}),c.merchant({blockTag:block}),t.decimals({blockTag:block})]);if(boundToken.toLowerCase()!==ds.token.toLowerCase()||merchant.toLowerCase()!==ds.merchant?.toLowerCase()||Number(decimals)!==ds.decimals)throw new Error('Constructor binding mismatch');
    return {datasetId:ds.id,chainId:ds.chainId,blockNumber:block,tokenCodeHash:keccak256(tokenCode),escrowCodeHash:keccak256(escrowCode),runtimeMatches:true,immutableBindingsVerified:true,compiler:escrow.compiler,settings:escrow.settings,verifiedAt:new Date().toISOString(),sourceVerification:'Local compiled runtime comparison, not an explorer source-verification badge'};
  }finally{p.destroy();}
}
