import type {FlowDeployment,FlowEvent} from './flow.ts';
export type FlowView='consumer'|'merchant'|'analysis';
export type PaymentRole='userA'|'userB'|'merchant';
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export function viewFromPath(path:string):FlowView{if(path==='/merchant')return 'merchant';if(['/analysis','/investigations','/ai'].includes(path))return 'analysis';return 'consumer';}
export function accountEvents(events:FlowEvent[],d:FlowDeployment|undefined,role:PaymentRole){if(!d)return [];const account=d.accounts[role];return events.filter(e=>same(e.from,account)||same(e.to,account)).sort((a,b)=>b.blockNumber-a.blockNumber||b.logIndex-a.logIndex);}
export function accountTotals(events:FlowEvent[],account:string){let incoming=0n,outgoing=0n;for(const e of events){if(same(e.from,e.to))continue;if(same(e.to,account))incoming+=BigInt(e.amount);if(same(e.from,account))outgoing+=BigInt(e.amount);}return {incoming:incoming.toString(),outgoing:outgoing.toString()};}
export function percentBps(value:string|null){if(value===null)return '无法计算';const n=BigInt(value);return `${n/100n}.${(n%100n).toString().padStart(2,'0')}%`;}
