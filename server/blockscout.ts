import {isAddress} from 'ethers';
export type IndexedTransfer={block_hash:string;block_number:number;log_index:number;timestamp:string;transaction_hash:string;from:{hash:string};to:{hash:string};token:{address_hash:string;decimals:string};total:{value:string}};
export async function indexedTransfers(address:string,token:string,fromBlock:number,toBlock:number,maxPages=25,signal?:AbortSignal){
  if(!isAddress(address)||!isAddress(token))throw new Error('Invalid indexed transfer scope');
  const root=new URL(`https://eth.blockscout.com/api/v2/addresses/${address}/token-transfers`),items=new Map<string,IndexedTransfer>(),pages:{url:string;receivedAt:string;response:unknown}[]=[];
  let cursor:Record<string,unknown>={block_number:toBlock+1,index:0},complete=false;
  for(let page=0;page<maxPages;page++){
    const url=new URL(root);url.searchParams.set('token',token);url.searchParams.set('type','ERC-20');
    for(const [k,v] of Object.entries(cursor)){if(!['index','block_number','items_count','token','batch_block_hash','batch_transaction_hash','batch_log_index','index_in_batch'].includes(k))throw new Error('Unexpected pagination key');if(typeof v==='string'||typeof v==='number')url.searchParams.set(k,String(v));}
    const res=await fetch(url,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000)});if(!res.ok)throw new Error('Public index HTTP '+res.status);
    const body=await res.json();if(!Array.isArray(body.items))throw new Error('Invalid public index response');pages.push({url:url.toString(),receivedAt:new Date().toISOString(),response:body});
    for(const row of body.items as IndexedTransfer[]){
      if(row.token?.address_hash?.toLowerCase()!==token.toLowerCase()||![row.from?.hash?.toLowerCase(),row.to?.hash?.toLowerCase()].includes(address.toLowerCase())||!Number.isSafeInteger(row.block_number)||!/^\d+$/.test(row.total?.value||''))throw new Error('Public index scope mismatch');
      if(row.block_number>=fromBlock&&row.block_number<=toBlock)items.set(row.transaction_hash+':'+row.log_index,row);
    }
    if(body.items.some((i:IndexedTransfer)=>i.block_number<fromBlock)||!body.next_page_params){complete=true;break;}
    const next=body.next_page_params;if(JSON.stringify(next)===JSON.stringify(cursor))throw new Error('Pagination did not advance');cursor=next;
  }
  if(!complete)throw new Error('Public index pagination budget exceeded; incomplete window');
  return {items:[...items.values()],pages,complete,source:'https://eth.blockscout.com',limitation:'完整分页的探索器索引窗口；逐条收据核验不能单独证明索引绝无遗漏。'};
}
