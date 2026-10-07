import {id,zeroPadValue} from 'ethers';

export const TRANSFER_TOPIC=id('Transfer(address,address,uint256)');
export const addressTopic=(address:string)=>zeroPadValue(address.toLowerCase(),32);
export const hex=(number:number)=>'0x'+number.toString(16);
export type RawLog={address:string;topics:string[];data:string;blockNumber:string;blockHash:string;transactionHash:string;transactionIndex:string;logIndex:string;removed?:boolean};
export class ReadRpc {
  requests=0;trace:{method:string;params:unknown[];ok:boolean;at:string;host:string}[]=[];
  blocks=new Map<number,any>();
  constructor(readonly url:string,readonly budget=600,readonly signal?:AbortSignal,readonly fallbackUrl?:string){}
  async call<T=any>(method:string,params:unknown[]):Promise<T>{
    if(!['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getLogs','eth_getTransactionByHash','eth_getTransactionReceipt','eth_call','eth_getBalance','eth_getCode'].includes(method))throw new Error('Read-only RPC method required');
    let last:unknown;
    for(let attempt=0;attempt<3;attempt++){
      if(++this.requests>this.budget)throw new Error('RPC request budget exceeded');
      this.signal?.throwIfAborted();const endpoint=attempt===1&&this.fallbackUrl?this.fallbackUrl:this.url;const trace={method,params,ok:false,at:new Date().toISOString(),host:new URL(endpoint).hostname};this.trace.push(trace);
      try{const attemptTimeout=this.fallbackUrl?3500:12000,signal=this.signal?AbortSignal.any([this.signal,AbortSignal.timeout(attemptTimeout)]):AbortSignal.timeout(attemptTimeout);
        const res=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:this.requests,method,params}),signal});
        if(!res.ok)throw new Error('RPC HTTP '+res.status);const body=await res.json();if(body.error||body.result===undefined)throw new Error('RPC method rejected: '+method+' code '+(body.error?.code??'missing')+' '+String(body.error?.message||'').slice(0,180));if(['eth_getTransactionReceipt','eth_getTransactionByHash'].includes(method)&&body.result===null)throw new Error('RPC transaction temporarily unavailable');trace.ok=true;return body.result as T;
      }catch(error){last=error;if(this.signal?.aborted)throw error;}
    }
    throw last;
  }
  async block(number:number|'latest'|'finalized'){if(typeof number==='number'&&this.blocks.has(number))return this.blocks.get(number);const b=await this.call('eth_getBlockByNumber',[typeof number==='number'?hex(number):number,false]);if(!b?.hash)throw new Error('Missing RPC block');const result={...b,number:Number(BigInt(b.number)),timestamp:Number(BigInt(b.timestamp))};this.blocks.set(result.number,result);return result;}
  async blockAt(timestamp:number,head:number){const latest=await this.block(head);let lo=Math.max(0,head-Math.ceil((latest.timestamp-timestamp)/10)-20000),hi=head;const lower=await this.block(lo);if(lower.timestamp>timestamp)lo=0;while(lo<hi){const mid=Math.floor((lo+hi)/2),b=await this.block(mid);if(b.timestamp<timestamp)lo=mid+1;else hi=mid;}return lo;}
  async logs(token:string,from:number,to:number,topics:(string|null)[],maxLogs=5000):Promise<RawLog[]>{
    const output:RawLog[]=[];let start=from,chunk=5000;
    while(start<=to){const stop=Math.min(to,start+chunk-1);let logs:RawLog[];
      try{logs=await this.call('eth_getLogs',[{address:token,fromBlock:hex(start),toBlock:hex(stop),topics}]);}
      catch(error){if(chunk<=50)throw error;chunk=Math.max(50,Math.floor(chunk/2));continue;}
      if(output.length+logs.length>maxLogs)throw new Error('RPC log budget exceeded');
      if(logs.some(l=>l.removed))throw new Error('Removed log encountered');output.push(...logs);start=stop+1;
    }
    return output;
  }
}
