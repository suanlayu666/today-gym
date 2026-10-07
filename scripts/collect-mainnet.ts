import fs from 'node:fs';
import {Interface,ZeroAddress} from 'ethers';
import {config,writeJSON} from '../server/config.ts';
import {ReadRpc,TRANSFER_TOPIC,addressTopic,hex,type RawLog} from '../server/rpc.ts';
import {MAINNET_RULE,mainnetMetrics} from '../server/mainnet-metrics.ts';
import {Store} from '../server/store.ts';
import {ChainService,tokenAbi} from '../server/chain.ts';
import {stableId} from '../server/rules.ts';
import type {Dataset,ChainEvent} from '../shared/types.ts';
import {indexedTransfers} from '../server/blockscout.ts';

const token='0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',sourceUrl='https://developers.circle.com/stablecoins/usdc-contract-addresses';
const rpc=new ReadRpc(config.mainnetRpc,1800,AbortSignal.timeout(480000),config.mainnetFallbackRpc),iface=new Interface(tokenAbi),store=new Store(),chain=new ChainService(store);
async function main(){
  if(Number(BigInt(await rpc.call('eth_chainId',[])))!==1)throw new Error('Mainnet chainId mismatch');
  const expanded=process.argv.includes('--expanded'),planFile=expanded?'cases/mainnet/research-plan-expanded.json':'cases/mainnet/research-plan.json';
  if(!fs.existsSync(planFile))writeJSON(planFile,{rule:MAINNET_RULE,recordedAt:new Date().toISOString(),selection:expanded?'保留第一正常候选。从原始120块样本其后候选中，固定选择最多4个大额（至少100000 USDC）且样本中正额转出不超过2笔的目标。规则不变；这是披露的探索性扩大检索，不是独立预测验证。':'检索最近完整 UTC 日末 120 个区块的 USDC 转账，按金额选前 3 个非零转出地址；采集此前 14 个完整日。依固定阈值选择异常与无提醒的正常对照窗口。',sourceUrl});
  const head=await rpc.block('finalized'),to=Math.floor(head.timestamp/86400)*86400,from=to-14*86400;
  const cacheFile='cases/mainnet/finalized-block-cache.json';if(fs.existsSync(cacheFile)){for(const block of JSON.parse(fs.readFileSync(cacheFile,'utf8'))){if(Number.isSafeInteger(block.number)&&block.number<=head.number)rpc.blocks.set(block.number,block);}}
  const [fromBlock,toStart]=await Promise.all([rpc.blockAt(from,head.number),rpc.blockAt(to,head.number)]),toBlock=toStart-1;
  // The free endpoint does not provide archived eth_call. Metadata is explicitly current,
  // never presented as a historical balance or state snapshot; metrics retain raw units.
  const decimals=Number(BigInt(await rpc.call('eth_call',[{to:token,data:iface.encodeFunctionData('decimals')},'latest'])));
  if(decimals!==6)throw new Error('USDC precision mismatch');
  const discovery=await rpc.logs(token,Math.max(fromBlock,toBlock-119),toBlock,[TRANSFER_TOPIC],10000);
  const decoded=discovery.map(l=>iface.parseLog(l)!).filter(l=>l&&String(l.args.from)!==ZeroAddress),ranked=Array.from(new Set(decoded.sort((a,b)=>BigInt(a.args.value)>BigInt(b.args.value)?-1:1).map(l=>String(l.args.from))));
  const candidates=expanded?[ranked[0],...ranked.slice(3).filter(address=>{const outgoing=decoded.filter(l=>String(l.args.from)===address&&BigInt(l.args.value)>0n);return outgoing.length<=2&&outgoing.some(l=>BigInt(l.args.value)>=BigInt(MAINNET_RULE.minRawAmount));}).slice(0,4)]:ranked.slice(0,3);
  writeJSON('cases/mainnet/discovery.json',{capturedAt:new Date().toISOString(),chainId:1,token,decimals,metadataRead:'decimals at latest, not an archived state read',from,to,fromBlock,toBlock,head,discovery,candidates});
  console.log(JSON.stringify({stage:'discovery',fromBlock,toBlock,candidates,rawLogs:discovery.length}));
  const selected:{ds:Dataset;events:ChainEvent[];metrics:ReturnType<typeof mainnetMetrics>;raw:unknown}[]=[];
  const cache=new Map<number,any>();
  const candidateErrors:{target:string;reason:string}[]=[];
  for(const target of candidates){
    try{
    const file=`cases/mainnet/${target.toLowerCase()}.raw.json`;let logs:RawLog[],blocks:any[];
    if(fs.existsSync(file)){const saved=JSON.parse(fs.readFileSync(file,'utf8'));if(saved.fromBlock===fromBlock&&saved.toBlock===toBlock){logs=saved.logs;blocks=saved.blocks;for(const b of blocks)cache.set(b.number,b);}else{logs=[];blocks=[];}}
    else{logs=[];blocks=[];}
    if(!blocks.length){
      console.log(JSON.stringify({stage:'target',target,source:'Blockscout index + individually verified RPC receipts'}));
      const indexFile=`cases/mainnet/${target.toLowerCase()}.index.json`,receiptFile=`cases/mainnet/${target.toLowerCase()}.receipts-cache.json`;
      const savedIndex=fs.existsSync(indexFile)?JSON.parse(fs.readFileSync(indexFile,'utf8')):null;
      const indexed:Awaited<ReturnType<typeof indexedTransfers>>=savedIndex?.fromBlock===fromBlock&&savedIndex?.toBlock===toBlock?savedIndex.index:await indexedTransfers(target,token,fromBlock,toBlock,25,AbortSignal.timeout(120000));
      writeJSON(indexFile,{fromBlock,toBlock,index:indexed});
      const receipts=new Map<string,any>(fs.existsSync(receiptFile)?JSON.parse(fs.readFileSync(receiptFile,'utf8')):[]);
      const hashes=Array.from(new Set(indexed.items.map(i=>i.transaction_hash)));if(hashes.length>500)throw new Error('Candidate receipt budget exceeded');
      for(let offset=0;offset<hashes.length;offset+=4){await Promise.all(hashes.slice(offset,offset+4).map(async h=>{if(receipts.has(h))return;const r=await rpc.call('eth_getTransactionReceipt',[h]);if(!r||r.status!=='0x1')throw new Error('Missing or failed source receipt '+h);receipts.set(h,r);}));writeJSON(receiptFile,[...receipts]);}
      logs=indexed.items.map(item=>{const receipt=receipts.get(item.transaction_hash);const log=receipt.logs.find((l:RawLog)=>Number(BigInt(l.logIndex))===item.log_index&&l.address.toLowerCase()===token.toLowerCase());if(!log)throw new Error('Indexed log missing from actual receipt');const decoded=iface.parseLog(log)!;
        if(String(decoded.args.from).toLowerCase()!==item.from.hash.toLowerCase()||String(decoded.args.to).toLowerCase()!==item.to.hash.toLowerCase()||String(decoded.args.value)!==item.total.value||log.blockHash!==item.block_hash||Number(BigInt(log.blockNumber))!==item.block_number)throw new Error('Index/receipt disagreement');return log;
      });
      writeJSON(`cases/mainnet/${target.toLowerCase()}.sources.json`,{index:indexed,receipts:[...receipts.values()],verifiedAt:new Date().toISOString(),limitation:indexed.limitation});
      const numbers=Array.from(new Set(logs.map(l=>Number(BigInt(l.blockNumber)))));if(numbers.length>2500)throw new Error('Candidate exceeds block lookup budget');
      for(let offset=0;offset<numbers.length;offset+=4){await Promise.all(numbers.slice(offset,offset+4).map(async n=>{if(!cache.has(n))cache.set(n,await rpc.block(n));}));}
      blocks=[...numbers.map(n=>cache.get(n)),await rpc.block(fromBlock),await rpc.block(toBlock)];writeJSON(file,{chainId:1,token,target,fromBlock,toBlock,from,to,logs,blocks,capturedAt:new Date().toISOString(),coverageComplete:true});
    }
    for(let day=7;day<14;day++){
      const window={from:from+day*86400,to:from+(day+1)*86400};const cutoff=(await rpc.blockAt(window.to,head.number))-1;
      const ds:Dataset={id:`mainnet-usdc-${target.slice(2,10).toLowerCase()}-${window.from}`,chainId:1,dataOrigin:'public-mainnet',adapter:'erc20',name:`USDC 地址 ${target.slice(0,10)} · ${new Date(window.from*1000).toISOString().slice(0,10)}`,token,tokenSymbol:'USDC',decimals,deploymentBlock:fromBlock,fromBlock,toBlock:cutoff,target,sourceUrl,analysisWindow:window,baselineDays:7,ruleVersion:MAINNET_RULE.version,collection:{capturedAt:new Date().toISOString(),rpcHost:new URL(config.mainnetRpc).hostname,selection:'120 块大额样本候选；固定阈值筛选，非独立预测验证',complete:true,rawFile:file}};
      const events:ChainEvent[]=logs.filter(l=>Number(BigInt(l.blockNumber))<=cutoff).map(l=>{const parsed=iface.parseLog(l)!,n=Number(BigInt(l.blockNumber)),block=cache.get(n);if(block.hash!==l.blockHash)throw new Error('Log block hash mismatch');return {id:stableId('event',[ds.id,l.transactionHash,Number(BigInt(l.logIndex))]),datasetId:ds.id,chainId:1,address:l.address,name:parsed.name,args:{from:String(parsed.args.from),to:String(parsed.args.to),value:String(parsed.args.value)},txHash:l.transactionHash,blockNumber:n,blockHash:l.blockHash,timestamp:block.timestamp,transactionIndex:Number(BigInt(l.transactionIndex)),logIndex:Number(BigInt(l.logIndex)),finality:'finalized' as const};}).sort((a,b)=>a.blockNumber-b.blockNumber||a.logIndex-b.logIndex);
      ds.collection!.followupFromBlock=await rpc.blockAt(window.from,head.number);
      ds.collection!.capturedAt=JSON.parse(fs.readFileSync(file,'utf8')).capturedAt;ds.collection!.indexHost='eth.blockscout.com';ds.collection!.coverageMethod='bounded-index-pagination + every returned transfer checked against RPC receipt and block';ds.collection!.limitations=['无法独立证明第三方索引绝无遗漏。','代币精度是当前读取，不是历史 eth_call。','探索性选样，不是独立预测验证。'];
      const metrics=mainnetMetrics(ds,events);selected.push({ds,events,metrics,raw:file});
    }
    console.log(JSON.stringify({stage:'target-complete',target,logs:logs.length,requests:rpc.requests}));
    if(selected.some(c=>c.metrics.flags.length)&&selected.some(c=>!c.metrics.flags.length))break;
    }catch(error){candidateErrors.push({target,reason:error instanceof Error?error.message:'Unavailable'});writeJSON('cases/mainnet/candidate-errors.json',candidateErrors);console.log(JSON.stringify({stage:'candidate-unavailable',target,reason:candidateErrors.at(-1)!.reason}));if(rpc.signal?.aborted)throw error;}
  }
  const anomaly=selected.filter(c=>c.metrics.flags.length).sort((a,b)=>BigInt(a.metrics.current.total)>BigInt(b.metrics.current.total)?-1:1)[0];
  const control=selected.filter(c=>!c.metrics.flags.length&&c.metrics.current.count>0).sort((a,b)=>BigInt(a.metrics.current.total)>BigInt(b.metrics.current.total)?-1:1)[0]||selected.find(c=>!c.metrics.flags.length);
  writeJSON('cases/mainnet/exploration.json',{rule:MAINNET_RULE,windows:selected.map(c=>({id:c.ds.id,target:c.ds.target,window:c.ds.analysisWindow,metrics:c.metrics})),candidateErrors,rpcRequests:rpc.requests,trace:rpc.trace});
  if(!anomaly||!control)throw new Error('No independently qualifying anomaly/control pair found; keep exploration record');
  for(const [role,c] of [['anomaly',anomaly],['control',control]] as const){c.ds.caseRole=role;c.ds.name=(role==='anomaly'?'主网异动案例':'主网正常对照')+' · '+c.ds.name;
    const cutoff=await rpc.block(c.ds.toBlock!);store.transaction(()=>{store.put('datasets',c.ds);for(const e of c.events){store.addEvent(e);store.put('evidence',chain.eventEvidence(c.ds,e));store.block(c.ds.id,e.blockNumber,e.blockHash);}store.block(c.ds.id,cutoff.number,cutoff.hash);store.checkpointPut(c.ds.id,{blockNumber:cutoff.number,blockHash:cutoff.hash,timestamp:cutoff.timestamp,head:head.number,status:'ok',coverageComplete:true,coverageMethod:c.ds.collection?.coverageMethod,fromBlock,fromTimestamp:from,toTimestamp:c.ds.analysisWindow!.to,syncedAt:new Date().toISOString(),replay:true});});
    for(const flag of c.metrics.flags){const alertId=stableId('alert',[c.ds.id,flag]);store.put('alerts',{id:alertId,datasetId:c.ds.id,ruleId:flag,title:flag==='MAIN_GROWTH'?'转出总额偏离七日基线':'大额转出的单笔集中度较高',severity:'attention',evidenceIds:c.metrics.current.eventIds,metrics:{amount:c.metrics.current.total,relativeTotalBps:c.metrics.relativeTotalBps??'不可计算',singleConcentrationBps:c.metrics.current.singleConcentrationBps??'不可计算',ruleVersion:MAINNET_RULE.version},window:c.ds.analysisWindow!});}
    writeJSON(`cases/mainnet/${role}.manifest.json`,c.ds);writeJSON(`cases/mainnet/${role}.metrics.json`,c.metrics);
    const evidence=await chain.tx(c.ds,c.metrics.current.eventIds.length?c.events.find(e=>e.id===c.metrics.current.eventIds[0])!.txHash:c.events.at(-1)!.txHash);
    writeJSON(`cases/mainnet/${role}.receipt.json`,evidence);console.log(JSON.stringify({stage:'selected',role,dataset:c.ds.id,flags:c.metrics.flags,txHash:evidence.txHash}));
  }
}
try{await main();}catch(error){writeJSON('cases/mainnet/last-failure.json',{at:new Date().toISOString(),error:error instanceof Error?error.message:'Unknown',requests:rpc.requests,trace:rpc.trace});throw error;}finally{writeJSON('cases/mainnet/finalized-block-cache.json',[...rpc.blocks.values()]);store.close();}
