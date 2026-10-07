import fs from 'node:fs';
import {Contract,ContractFactory,JsonRpcProvider,Wallet,parseEther,parseUnits,keccak256} from 'ethers';
import {config,readJSON,writeJSON} from '../server/config.ts';
import {compile} from './compile.ts';
import {deploymentProof} from '../server/deployment-proof.ts';
import type {Dataset} from '../shared/types.ts';

const execute=process.argv.includes('--execute'),walletFile='.runtime/sepolia-wallets.json',journal='data/sepolia/deployment-journal.json';
if(!fs.existsSync(walletFile))throw new Error('Run prepare-sepolia.ts first; no personal key is accepted');
const saved=readJSON(walletFile);if(saved.chainId!==11155111)throw new Error('Sepolia-only signing file required');
const p=new JsonRpcProvider(config.sepoliaRpc,11155111,{staticNetwork:true,cacheTimeout:-1});
try{
  if(Number(await p.send('eth_chainId',[]))!==11155111)throw new Error('Signing network mismatch');compile();
  const keys=saved.accounts,merchant=new Wallet(keys.merchant.privateKey,p),tokenArtifact=readJSON('shared/artifacts/GymToken.json'),escrowArtifact=readJSON('shared/artifacts/GymEscrow.json');
  const maximumFee=parseUnits('3','gwei'),maxTotalFee=parseEther('0.03'),balance=await p.getBalance(merchant.address),fee=await p.getFeeData();
  const plan={chainId:11155111,network:'Ethereum Sepolia; no-value testing only',execute,merchant:merchant.address,users:[keys.userA.address,keys.userB.address],payout:keys.payout.address,tokenInit:[30000,30000,30000],maxFeePerGas:maximumFee.toString(),maxTotalFee:maxTotalFee.toString(),maximumTransactions:4,balance:balance.toString(),gasLimits:{token:1500000,escrow:2800000},tokenCreationHash:keccak256(tokenArtifact.bytecode),escrowCreationHash:keccak256(escrowArtifact.bytecode),compiler:escrowArtifact.compiler,preparedAt:new Date().toISOString()};
  writeJSON('artifacts/acceptance/sepolia-deployment-plan.json',plan);console.log(JSON.stringify({planSaved:true,execute,chainId:11155111,merchant:merchant.address,balance:balance.toString(),fundingRequired:balance<parseEther('0.02')}));
  if(execute){
    if(balance<parseEther('0.02'))throw new Error('Not enough free Sepolia ETH; no transaction sent');if((fee.maxFeePerGas??0n)>maximumFee)throw new Error('Network fee exceeds configured Sepolia cap');
    const progress=fs.existsSync(journal)?readJSON(journal):{chainId:11155111,merchant:merchant.address,steps:[],spent:'0'};if(progress.chainId!==11155111||progress.merchant.toLowerCase()!==merchant.address.toLowerCase())throw new Error('Deployment journal does not match wallet');
    const overrides={maxFeePerGas:maximumFee,maxPriorityFeePerGas:parseUnits('0.1','gwei')};
    const step=async(name:string,send:()=>Promise<any>)=>{
      let existing=progress.steps.find((s:any)=>s.name===name);if(existing?.complete)return existing;
      if(Number(await p.send('eth_chainId',[]))!==11155111)throw new Error('Network changed before signing');
      if(progress.steps.length>=plan.maximumTransactions&&!existing)throw new Error('Deployment transaction cap reached');
      if(!existing){const tx=await send();existing={name,txHash:tx.hash,createdAt:new Date().toISOString()};progress.steps.push(existing);writeJSON(journal,progress);}
      const receipt=await p.waitForTransaction(existing.txHash,1,120000);if(!receipt)throw new Error('Transaction still pending; resume the same hash, do not resend');if(receipt.status!==1)throw new Error('Deployment step reverted; journal retained');
      const cost=receipt.gasUsed*receipt.gasPrice;progress.spent=(BigInt(progress.spent)+cost).toString();if(BigInt(progress.spent)>maxTotalFee)throw new Error('Total Sepolia fee cap exceeded; stop');Object.assign(existing,{complete:true,blockNumber:receipt.blockNumber,contractAddress:receipt.contractAddress,cost:cost.toString()});writeJSON(journal,progress);return existing;
    };
    const tokenStep=await step('token',async()=>{const c=await new ContractFactory(tokenArtifact.abi,tokenArtifact.bytecode,merchant).deploy([keys.userA.address,keys.userB.address,merchant.address],[30000,30000,30000],{...overrides,gasLimit:plan.gasLimits.token});return c.deploymentTransaction();});
    const escrowStep=await step('escrow',async()=>{const c=await new ContractFactory(escrowArtifact.abi,escrowArtifact.bytecode,merchant).deploy(tokenStep.contractAddress,merchant.address,keys.payout.address,{...overrides,gasLimit:plan.gasLimits.escrow});return c.deploymentTransaction();});
    for(const role of ['userA','userB'])await step('fund-'+role,()=>merchant.sendTransaction({to:keys[role].address,value:parseEther('0.003'),gasLimit:21000,...overrides}));
    const ds:Dataset={id:'sepolia-'+escrowStep.contractAddress.toLowerCase(),name:'Sepolia 健身房演示',chainId:11155111,dataOrigin:'public-testnet',adapter:'gym',token:tokenStep.contractAddress,escrow:escrowStep.contractAddress,merchant:merchant.address,payout:keys.payout.address,nextPayout:keys.nextPayout.address,users:[keys.userA.address,keys.userB.address],tokenSymbol:'GYM',decimals:0,deploymentBlock:tokenStep.blockNumber};
    const proof=await deploymentProof(ds);writeJSON('artifacts/acceptance/sepolia-deployment-proof.json',{...proof,transactions:progress.steps,fees:progress.spent});writeJSON('data/deployments/sepolia.json',ds);console.log(JSON.stringify({deployed:true,datasetId:ds.id,token:ds.token,escrow:ds.escrow}));
  }
}finally{p.destroy();}
