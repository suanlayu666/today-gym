import { JsonRpcProvider,ContractFactory,Wallet } from 'ethers';
import { config, readJSON, writeJSON } from '../server/config.ts';
import { compile } from './compile.ts';
export async function deployLocal(publish=true) {
  const provider=new JsonRpcProvider(config.localRpc,31337,{staticNetwork:true,cacheTimeout:-1});
  if(Number((await provider.getNetwork()).chainId)!==31337 || Number(await provider.send('eth_chainId',[]))!==31337) throw new Error('Local deployment requires chain 31337');
  const accounts=await provider.listAccounts();
  if(accounts.length<6) throw new Error('Local chain needs six test accounts');
  const [merchant,userA,userB,userC,payout,nextPayout]=accounts;
  compile();
  const tokenArtifact=readJSON('shared/artifacts/GymToken.json'), escrowArtifact=readJSON('shared/artifacts/GymEscrow.json');
  const token:any=await new ContractFactory(tokenArtifact.abi,tokenArtifact.bytecode,merchant).deploy([userA.address,userB.address,userC.address,merchant.address],[30000,30000,30000,30000]);
  const tokenReceipt=await token.deploymentTransaction()!.wait();
  const escrow:any=await new ContractFactory(escrowArtifact.abi,escrowArtifact.bytecode,merchant).deploy(await token.getAddress(),merchant.address,payout.address);
  const escrowReceipt=await escrow.deploymentTransaction()!.wait();
  const manifest={id:`local-${escrowReceipt!.blockNumber}-${Date.now()}`,chainId:31337,dataOrigin:'local-chain',adapter:'gym',name:'本地健身房',token:await token.getAddress(),escrow:await escrow.getAddress(),merchant:merchant.address,payout:payout.address,users:[userA.address,userB.address,userC.address],nextPayout:nextPayout.address,tokenSymbol:'GYM',decimals:0,deploymentBlock:tokenReceipt!.blockNumber,deployedAt:new Date().toISOString(),transactions:[tokenReceipt!.hash,escrowReceipt!.hash]};
  if(publish)writeJSON('data/deployments/local.json',manifest);
  console.log(JSON.stringify({deployed:true,chainId:31337,token:manifest.token,escrow:manifest.escrow}));
  return {provider,accounts,token,escrow,manifest};
}
if(process.argv[1]?.endsWith('deploy.ts')) {
  if(process.argv[2]!=='local') throw new Error('Public deployment uses the dedicated Sepolia workflow; no mainnet signer.');
  await deployLocal();
}
