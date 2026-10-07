import {createHash} from 'node:crypto';
import type {Dataset,ChainEvent,Alert} from '../shared/types.ts';
export const stableId=(prefix:string,value:unknown)=>prefix+'-'+createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);
export const basisPoints=(numerator:bigint,denominator:bigint)=>denominator===0n?null:(numerator*10000n/denominator).toString();
export function gymAlerts(ds:Dataset,events:ChainEvent[],timestamp:number,snapshot:any):Alert[]{
  const to=timestamp+1,from=to-86400;const recent=events.filter(e=>e.timestamp>=from&&e.timestamp<to);const result:Alert[]=[];
  const add=(ruleId:string,title:string,refs:ChainEvent[],metrics:Record<string,string>,severity:Alert['severity']='attention')=>result.push({id:stableId('alert',[ds.id,ruleId,refs.map(e=>e.id)]),datasetId:ds.id,ruleId,title,severity,evidenceIds:refs.map(e=>e.id),metrics,window:{from,to}});
  const withdrawals=recent.filter(e=>e.name==='Withdrawn');
  if(withdrawals.length){const total=withdrawals.reduce((n,e)=>n+BigInt(e.args.amount),0n),denominator=BigInt(withdrawals[0].args.availableBefore),ratio=basisPoints(total,denominator);
    if(total>=300n&&ratio!==null&&BigInt(ratio)>=8000n)add('R1','已结算额度集中提现',withdrawals,{amount:total.toString(),denominator:denominator.toString(),basisPoints:ratio,formula:'窗口提现合计 / 窗口首笔提现前可提额度'});
  }
  for(const change of recent.filter(e=>e.name==='PayoutAddressChanged')){
    const following=withdrawals.filter(w=>w.timestamp>=change.timestamp&&(w.blockNumber>change.blockNumber||(w.blockNumber===change.blockNumber&&w.logIndex>change.logIndex))&&w.timestamp<change.timestamp+86400);
    if(following.length)add('R2','变更收款地址后提现',[change,...following],{amount:following.reduce((n,e)=>n+BigInt(e.args.amount),0n).toString(),newAddress:change.args.newAddress});
    else add('ADDRESS_INFO','收款地址发生变更',[change],{newAddress:change.args.newAddress},'info');
  }
  const groups=new Map<string,ChainEvent[]>();for(const e of recent.filter(e=>e.name==='ConsumptionConfirmed')){const group=groups.get(e.args.user)||[];group.push(e);groups.set(e.args.user,group);}
  for(const [user,refs] of groups)if(refs.length>=3)add('R4','同一会员短时集中确认消费',refs,{user,count:String(refs.length),amount:refs.reduce((n,e)=>n+BigInt(e.args.amount),0n).toString()});
  if(snapshot&&BigInt(snapshot.assets)<BigInt(snapshot.userCredit)+BigInt(snapshot.revenue)){
    result.push({id:stableId('alert',[ds.id,'R6',snapshot.blockNumber]),datasetId:ds.id,ruleId:'R6',title:'托管资产低于账面负债，需先核验数据',severity:'critical',evidenceIds:[snapshot.evidenceId],metrics:{assets:snapshot.assets,liabilities:(BigInt(snapshot.userCredit)+BigInt(snapshot.revenue)).toString()},window:{from,to}});
  }
  return result;
}
export function transferMetrics(events:ChainEvent[],target:string,from:number,to:number){
  const outgoing=events.filter(e=>e.name==='Transfer'&&e.args.from.toLowerCase()===target.toLowerCase()&&e.timestamp>=from&&e.timestamp<to);
  const total=outgoing.reduce((n,e)=>n+BigInt(e.args.value),0n),max=outgoing.reduce((n,e)=>BigInt(e.args.value)>n?BigInt(e.args.value):n,0n);
  const recipients:Record<string,bigint>={};for(const e of outgoing)recipients[e.args.to]=(recipients[e.args.to]||0n)+BigInt(e.args.value);
  const top=Object.entries(recipients).sort((a,b)=>a[1]===b[1]?0:a[1]>b[1]?-1:1)[0];
  return {from,to,total:total.toString(),count:outgoing.length,maxSingle:max.toString(),singleConcentrationBps:basisPoints(max,total),topRecipient:top?.[0]||null,recipientConcentrationBps:basisPoints(top?.[1]||0n,total),eventIds:outgoing.map(e=>e.id)};
}
