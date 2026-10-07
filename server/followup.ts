import type {ChainEvent,Dataset} from '../shared/types.ts';

// This is a fixed, disclosed observation horizon, not a promise of full fund tracing.
export const FOLLOWUP_BLOCKS=120;
export function followupScope(ds:Dataset,events:ChainEvent[],address:string,cutoff:number){
  const lower=ds.collection?.followupFromBlock??Math.max(ds.fromBlock??ds.deploymentBlock,cutoff-7200);
  if(ds.adapter!=='erc20'||!ds.target) return {fromBlock:lower,toBlock:cutoff,anchor:null,horizonBlocks:null};
  const candidates=events.filter(e=>e.name==='Transfer'&&e.blockNumber<=cutoff&&e.blockNumber>=lower&&
    e.args.from?.toLowerCase()===ds.target!.toLowerCase()&&e.args.to?.toLowerCase()===address.toLowerCase()&&
    BigInt(e.args.value??'0')>0n&&(!ds.analysisWindow||(e.timestamp>=ds.analysisWindow.from&&e.timestamp<ds.analysisWindow.to)));
  const anchor=candidates.sort((a,b)=>BigInt(a.args.value)===BigInt(b.args.value)?b.blockNumber-a.blockNumber||b.logIndex-a.logIndex:BigInt(a.args.value)>BigInt(b.args.value)?-1:1)[0];
  if(!anchor)throw new Error('No positive incoming transfer from target in evaluation window; choose its actual recipient');
  return {fromBlock:anchor.blockNumber,toBlock:Math.min(cutoff,anchor.blockNumber+FOLLOWUP_BLOCKS),
    anchor:{eventId:anchor.id,txHash:anchor.txHash,blockNumber:anchor.blockNumber,logIndex:anchor.logIndex,value:anchor.args.value},horizonBlocks:FOLLOWUP_BLOCKS};
}
