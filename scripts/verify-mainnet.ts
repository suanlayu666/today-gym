import assert from 'node:assert/strict';
import {Interface} from 'ethers';
import {Store} from '../server/store.ts';
import {readJSON,writeJSON,config} from '../server/config.ts';
import {tokenAbi} from '../server/chain.ts';
import {mainnetMetrics} from '../server/mainnet-metrics.ts';
import {followupScope} from '../server/followup.ts';
import {ReadRpc} from '../server/rpc.ts';
import {stableId} from '../server/rules.ts';
import {validateDraft,reportMarkdown} from '../server/agent.ts';
import {verifiedFacts,orderedFacts,FACT_VERSION} from '../server/report-facts.ts';
import type {Dataset,ChainEvent,Evidence,Report} from '../shared/types.ts';

const store=new Store(),iface=new Interface(tokenAbi),online=process.argv.includes('--online');
const checks:{name:string;passed:boolean;details?:unknown}[]=[],results:unknown[]=[];
const check=(name:string,fn:()=>unknown)=>{const details=fn();checks.push({name,passed:true,...(details===undefined?{}:{details})});};
const rpc=new ReadRpc(config.mainnetRpc,30,AbortSignal.timeout(45000),config.mainnetFallbackRpc);
try{
  if(online)assert.equal(Number(BigInt(await rpc.call('eth_chainId',[]))),1);
  for(const role of ['anomaly','control'] as const){
    const ds=readJSON(`cases/mainnet/${role}.manifest.json`) as Dataset,raw=readJSON(ds.collection!.rawFile),sources=readJSON(`cases/mainnet/${ds.target!.toLowerCase()}.sources.json`);
    check(role+': network, token and source scope',()=>{assert.equal(ds.chainId,1);assert.equal(ds.dataOrigin,'public-mainnet');assert.equal(raw.chainId,1);assert.equal(raw.token.toLowerCase(),ds.token.toLowerCase());assert.equal(raw.target.toLowerCase(),ds.target!.toLowerCase());assert.equal(sources.index.complete,true);assert.equal(ds.baselineDays,7);assert.equal(ds.decimals,6);});
    const blocks=new Map<number,any>(raw.blocks.map((b:any)=>[b.number,b])),receipts=new Map<string,any>(sources.receipts.map((r:any)=>[r.transactionHash.toLowerCase(),r]));
    const replay:ChainEvent[]=raw.logs.filter((l:any)=>Number(BigInt(l.blockNumber))<=ds.toBlock!).map((l:any)=>{
      const receipt=receipts.get(l.transactionHash.toLowerCase());assert.equal(receipt?.status,'0x1');
      const returned=receipt.logs.find((v:any)=>v.logIndex===l.logIndex);assert.deepEqual(returned,l);
      const n=Number(BigInt(l.blockNumber)),b=blocks.get(n);assert.equal(b?.hash,l.blockHash);
      const p=iface.parseLog(l)!;assert.equal(p.name,'Transfer');assert.ok([String(p.args.from).toLowerCase(),String(p.args.to).toLowerCase()].includes(ds.target!.toLowerCase()));
      return {id:stableId('event',[ds.id,l.transactionHash,Number(BigInt(l.logIndex))]),datasetId:ds.id,chainId:1,address:l.address,name:p.name,args:{from:String(p.args.from),to:String(p.args.to),value:String(p.args.value)},txHash:l.transactionHash,blockNumber:n,blockHash:l.blockHash,timestamp:b.timestamp,transactionIndex:Number(BigInt(l.transactionIndex)),logIndex:Number(BigInt(l.logIndex)),finality:'finalized'};
    }).sort((a:ChainEvent,b:ChainEvent)=>a.blockNumber-b.blockNumber||a.logIndex-b.logIndex);
    check(role+': raw log/receipt/block internal consistency',()=>({verifiedReturnedTransfers:replay.length,independentCompletenessProof:false}));
    check(role+': persisted index equals raw replay',()=>assert.deepEqual(store.events(ds.id),replay));
    const metrics=mainnetMetrics(ds,replay);
    check(role+': deterministic metric replay',()=>assert.deepEqual(metrics,readJSON(`cases/mainnet/${role}.metrics.json`)));
    check(role+': unchanged alert criteria',()=>{assert.equal(metrics.rule.version,'usdc-flow-v1');assert.deepEqual(metrics.flags,role==='anomaly'?['MAIN_CONCENTRATION']:[]);});
    const report=store.list<Report>('reports',ds.id).find(r=>r.status==='complete'&&r.mode==='llm'&&r.analysis);
    assert.ok(report,'New report with deterministic analysis attachment is not complete yet');
    const evidence=store.list<Evidence>('evidence',ds.id).filter(e=>e.asOfBlock<=report.asOfBlock);
    const {headline,findings,hypotheses,consumerImpact,recommendations,limitations}=report;
    check(role+': current report citation/numeric validator',()=>{validateDraft({headline,findings,hypotheses,consumerImpact,recommendations,limitations},ds,evidence,report.asOfBlock);assert.equal(report.chainId,1);assert.equal(report.asOfBlock,ds.toBlock);assert.deepEqual(report.analysis!.metrics,metrics);assert.equal(report.analysis!.decimals,ds.decimals);assert.equal(report.analysis!.collection?.capturedAt,ds.collection?.capturedAt);});
    check(role+': factual statements reproduce successful tool evidence',()=>{assert.equal(report.analysis!.factGeneration,FACT_VERSION);assert.deepEqual(orderedFacts(report.findings.filter(f=>f.type==='fact')),orderedFacts(verifiedFacts(ds,evidence,report.toolRuns,report.asOfBlock)));});
    const successful=report.toolRuns.filter(t=>t.status==='ok');
    check(role+': actual Agent tools and associated-address increment',()=>{for(const name of ['compute_metrics','get_business_events','get_tx_evidence','get_token_transfers'])assert.ok(successful.some(t=>t.name===name));assert.ok(successful.some(t=>t.name==='get_token_transfers'&&(t.arguments as any)?.address?.toLowerCase()!==ds.target!.toLowerCase()));});
    const follows=successful.filter(t=>t.name==='get_token_transfers').flatMap(t=>t.evidenceIds).map(id=>evidence.find(e=>e.id===id)!).filter(e=>e?.facts.followup);
    check(role+': bounded follow-up source and returned receipt consistency',()=>{
      assert.ok(follows.length);
      for(const e of follows){const data=e.facts.followup as any,scope=followupScope(ds,replay,data.address,report.asOfBlock);assert.equal(data.ruleVersion,'post-receipt-120-v1');assert.equal(data.fromBlock,scope.fromBlock);assert.equal(data.toBlock,scope.toBlock);assert.ok(data.toBlock-data.fromBlock<=120);assert.ok(Array.isArray(e.facts.rawIndexPages)&&e.facts.rawIndexPages.length);
        const logList=e.facts.rawLogs as any[],followReceipts=e.facts.rawReceipts as any[];assert.equal(data.count,logList.length);
        let sum=0n;for(const l of logList){const r=followReceipts.find(r=>r.transactionHash.toLowerCase()===l.transactionHash.toLowerCase());assert.equal(r?.status,'0x1');assert.deepEqual(r.logs.find((v:any)=>v.logIndex===l.logIndex),l);const p=iface.parseLog(l)!;assert.equal(String(p.args.from).toLowerCase(),data.address.toLowerCase());sum+=BigInt(p.args.value);}
        assert.equal(data.totalRaw,sum.toString());
      }
      return follows.map(e=>({evidenceId:e.id,asOfBlock:e.asOfBlock,count:(e.facts.followup as any).count,positiveCount:(e.facts.followup as any).positiveCount}));
    });
    if(online){const sample=successful.find(t=>t.name==='get_tx_evidence')!,hash=(sample.arguments as any).txHash,e=evidence.find(e=>e.txHash===hash&&e.kind==='transaction')!;
      const fresh=await rpc.call('eth_getTransactionReceipt',[hash]);check(role+': online sample receipt recheck',()=>{assert.equal(fresh.blockHash,(e.facts as any).blockHash);assert.equal(Number(BigInt(fresh.status)),(e.facts as any).status);assert.deepEqual(fresh,(e.facts as any).rawReceipt);});
      const cutoff=await rpc.block(ds.toBlock!);check(role+': online cutoff still canonical',()=>assert.equal(cutoff.hash,store.checkpoint(ds.id).blockHash));
    }
    writeJSON(`artifacts/acceptance/mainnet-${role}-report.json`,report);
    writeJSON(`artifacts/acceptance/mainnet-${role}-evidence.json`,evidence.filter(e=>report.toolRuns.some(t=>t.evidenceIds.includes(e.id))));
    // Markdown is returned by the real API and checked separately; this JSON carries its exact text.
    writeJSON(`artifacts/acceptance/mainnet-${role}-markdown.json`,{reportId:report.id,markdown:reportMarkdown(report)});
    results.push({role,datasetId:ds.id,reportId:report.id,rawTransfers:replay.length,flags:metrics.flags});
  }
  console.log(JSON.stringify({passed:true,mode:online?'online-sample-and-offline-replay':'offline-replay',checks:checks.length,results},null,2));
}catch(error){checks.push({name:'verification halted',passed:false,details:error instanceof Error?error.message:'Unknown'});console.error(JSON.stringify(checks.at(-1)));process.exitCode=1;}
finally{writeJSON(`artifacts/acceptance/mainnet-verification.${online?'online':'offline'}.json`,{at:new Date().toISOString(),checks,results,rpcTrace:rpc.trace,limitations:['程序引用和数值检查不证明全部自然语言语义。','离线检查只验证已保存返回值；在线模式仅重新读取样本，不是全窗口独立重采。','完整索引分页仍不能独立证明第三方索引绝无遗漏。']});store.close();}
