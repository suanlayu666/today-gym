export function walletError(error:any){
  const codes=[error?.code,error?.error?.code,error?.info?.error?.code,error?.cause?.code];
  if(codes.some(code=>code==='ACTION_REJECTED'||code===4001||code==='4001'))return '已拒绝签名，未发送此笔交易。';
  return error?.shortMessage||error?.message||'操作失败';
}
export function writeReady(input:{account:string;adapter?:string;chainId?:number;walletChain?:number;dataError:string;configError:string;user:unknown;checkpoint?:{status?:string;coverageComplete?:boolean}}){
  return !!input.account&&input.adapter==='gym'&&input.chainId===input.walletChain&&!input.dataError&&!input.configError&&!!input.user&&input.checkpoint?.status==='ok'&&input.checkpoint.coverageComplete===true;
}
export function assertIdentity(current:{datasetId:string;account:string},datasetId:string,account:string){
  if(current.datasetId!==datasetId||current.account.toLowerCase()!==account.toLowerCase())throw new Error('账号或数据集已变化，请重新确认操作。');
}
