import fs from 'node:fs';
import path from 'node:path';
import {Wallet,formatEther} from 'ethers';
import {config,readJSON,writeJSON} from '../server/config.ts';
import {ReadRpc,hex} from '../server/rpc.ts';

const privateFile=path.resolve('.runtime/sepolia-wallets.json');
fs.mkdirSync(path.dirname(privateFile),{recursive:true,mode:0o700});
if(!fs.existsSync(privateFile)){
  const accounts=Object.fromEntries(['merchant','userA','userB','payout','nextPayout'].map(role=>{const wallet=Wallet.createRandom();return [role,{address:wallet.address,privateKey:wallet.privateKey}];}));
  fs.writeFileSync(privateFile,JSON.stringify({chainId:11155111,purpose:'Exclusive no-value Sepolia testing; never fund with mainnet assets',accounts},null,2),{mode:0o600,flag:'wx'});
}
const saved=readJSON(privateFile);if(saved.chainId!==11155111)throw new Error('Unexpected signing network');
const rpc=new ReadRpc(config.sepoliaRpc,20);
if(Number(BigInt(await rpc.call('eth_chainId',[])))!==11155111)throw new Error('Sepolia RPC chainId mismatch');
const accounts=Object.fromEntries(await Promise.all(Object.entries(saved.accounts).map(async([role,value]:[string,any])=>[role,{address:value.address,wei:await rpc.call('eth_getBalance',[value.address,'latest'])}])));
const publicInfo={chainId:11155111,network:'Ethereum Sepolia',preparedAt:new Date().toISOString(),rpcHost:new URL(config.sepoliaRpc).hostname,accounts,fundingAddress:(accounts.merchant as any).address,fundingNote:'只接收免费 Sepolia 测试 ETH，不能发送以太坊主网 ETH 或购买测试币。'};
writeJSON('artifacts/acceptance/sepolia-resources.json',publicInfo);
console.log(JSON.stringify({network:publicInfo.network,address:publicInfo.fundingAddress,balance:formatEther((accounts.merchant as any).wei),fundingNeeded:BigInt((accounts.merchant as any).wei)<10000000000000000n}));
