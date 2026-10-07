import type {ChainEvent} from './types.ts';
export function pendingRequests(events:ChainEvent[]){
  const closed=new Set(events.filter(e=>['ConsumptionConfirmed','ConsumptionRejected','ConsumptionCancelled','ConsumptionExpired'].includes(e.name)).map(e=>e.args.id));
  return events.filter(e=>e.name==='ConsumptionRequested'&&!closed.has(e.args.id));
}
export function confirmedToday(events:ChainEvent[],now=Date.now()){
  const day=new Date(now);day.setHours(0,0,0,0);const from=day.getTime()/1000;day.setDate(day.getDate()+1);const to=day.getTime()/1000;
  // Count the whole calendar day in the indexed canonical chain; a local EVM
  // block may be seconds ahead of the computer clock after fast mining.
  return events.filter(e=>e.name==='ConsumptionConfirmed'&&e.timestamp>=from&&e.timestamp<to).reduce((sum,e)=>sum+BigInt(e.args.amount),0n).toString();
}
