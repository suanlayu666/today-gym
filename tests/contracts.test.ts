import { describe,it,before,beforeEach,after } from 'node:test';
import assert from 'node:assert/strict';
import { ContractFactory,id,ZeroAddress } from 'ethers';
import {deployLocal} from '../scripts/deploy.ts';
import {readJSON,writeJSON} from '../server/config.ts';

describe('Actual EVM: GYM escrow permissions and accounting',{concurrency:false},()=>{
  let f:Awaited<ReturnType<typeof deployLocal>>, snapshot:string;
  const outcomes:string[]=[];
  before(async()=>{f=await deployLocal(false);snapshot=await f.provider.send('evm_snapshot',[]);});
  beforeEach(async()=>{await f.provider.send('evm_revert',[snapshot]);snapshot=await f.provider.send('evm_snapshot',[]);});
  after(()=>writeJSON('artifacts/acceptance/contracts-results.json',{generatedAt:new Date().toISOString(),chainId:31337,scope:'Real local EVM transactions',passed:outcomes,notCovered:['Sepolia','mainnet'],compiler:readJSON('shared/artifacts/GymEscrow.json').compiler}));
  const check=(name:string,fn:()=>Promise<void>)=>it(name,async()=>{await fn();outcomes.push(name);});
  const user=()=>f.accounts[1],merchant=()=>f.accounts[0];
  async function deposit(amount=3000n){await(await f.token.connect(user()).approve(f.manifest.escrow,amount)).wait();await(await f.escrow.connect(user()).deposit(amount)).wait();}
  async function request(key='visit'){const n=await f.escrow.nextRequestId();await(await f.escrow.requestConsumption(user().address,id(key))).wait();return n;}
  async function covered(){const [assets,credit,revenue,surplus,deficit]=await f.escrow.getAccounting();assert.equal(assets,credit+revenue+surplus);assert.equal(deficit,0n);}
  async function rejectUnchanged(fn:()=>Promise<unknown>){const before=Array.from(await f.escrow.getAccounting());await assert.rejects(fn);assert.deepEqual(Array.from(await f.escrow.getAccounting()),before);}

  check('FLOW-01: fixed supply, zero decimals and deposit 3000',async()=>{
    assert.equal(await f.token.decimals(),0n);assert.equal(await f.token.totalSupply(),120000n);await deposit();
    assert.equal(await f.token.balanceOf(user().address),27000n);assert.equal(await f.escrow.balances(user().address),3000n);await covered();
  });
  check('FLOW-02: request does not debit; confirmation moves exactly 30',async()=>{
    await deposit();const n=await request();assert.equal(await f.escrow.balances(user().address),3000n);assert.equal(await f.escrow.merchantAvailable(),0n);
    await(await f.escrow.connect(user()).confirmConsumption(n)).wait();assert.equal(await f.escrow.balances(user().address),2970n);assert.equal(await f.escrow.merchantAvailable(),30n);await covered();
  });
  check('FLOW-04: withdrawal transfers only earned revenue to payout',async()=>{
    await deposit();await(await f.escrow.connect(user()).confirmConsumption(await request())).wait();await(await f.escrow.withdraw(30)).wait();
    assert.equal(await f.escrow.merchantAvailable(),0n);assert.equal(await f.token.balanceOf(f.manifest.payout),30n);assert.equal(await f.escrow.balances(user().address),2970n);await covered();
  });
  check('SAFE-01: merchant cannot confirm, stranger cannot operate merchant',async()=>{
    await deposit();const n=await request();await rejectUnchanged(()=>f.escrow.confirmConsumption(n));
    for(const action of [()=>f.escrow.connect(user()).withdraw(1),()=>f.escrow.connect(user()).setPayoutAddress(user().address),()=>f.escrow.connect(user()).requestConsumption(user().address,id('unauthorized'))])await rejectUnchanged(action);
  });
  check('SAFE-01: other user cannot confirm, reject or refund another balance',async()=>{
    await deposit();const n=await request();const other=f.escrow.connect(f.accounts[2]);
    for(const action of [()=>other.confirmConsumption(n),()=>other.rejectConsumption(n),()=>other.refund(1)])await rejectUnchanged(action);
  });
  check('SAFE-01: over-withdrawal and repeated confirmation rejected',async()=>{
    await deposit();const n=await request();await rejectUnchanged(()=>f.escrow.withdraw(1));await(await f.escrow.connect(user()).confirmConsumption(n)).wait();
    await rejectUnchanged(()=>f.escrow.withdraw(31));await rejectUnchanged(()=>f.escrow.connect(user()).confirmConsumption(n));
  });
  check('FLOW-03: reject and cancel never generate merchant revenue',async()=>{
    await deposit();await(await f.escrow.connect(user()).rejectConsumption(await request('reject'))).wait();await(await f.escrow.cancelConsumption(await request('cancel'))).wait();
    assert.equal(await f.escrow.balances(user().address),3000n);assert.equal(await f.escrow.merchantAvailable(),0n);assert.equal(await f.escrow.activeRequest(user().address),0n);
  });
  check('FLOW-03: request expiry and automatic stale-request cleanup',async()=>{
    await deposit();const n=await request();await rejectUnchanged(()=>f.escrow.expireConsumption(n));
    await f.provider.send('evm_increaseTime',[86401]);await f.provider.send('evm_mine',[]);
    await rejectUnchanged(()=>f.escrow.connect(user()).confirmConsumption(n));await request('replacement');assert.equal((await f.escrow.requests(n)).status,5n);await covered();
  });
  check('SAFE-02: duplicate keys and concurrent requests rejected',async()=>{
    await deposit();const n=await request('same');await rejectUnchanged(()=>f.escrow.requestConsumption(user().address,id('another')));
    await(await f.escrow.connect(user()).rejectConsumption(n)).wait();await rejectUnchanged(()=>f.escrow.requestConsumption(user().address,id('same')));
  });
  check('SAFE-02: refund invalidates ability to over-confirm a pending request',async()=>{
    await deposit();const n=await request();await(await f.escrow.connect(user()).refund(3000)).wait();await rejectUnchanged(()=>f.escrow.connect(user()).confirmConsumption(n));
    assert.equal(await f.token.balanceOf(user().address),30000n);await covered();
  });
  check('SAFE-03: card expiry blocks top-up/consumption but not refund',async()=>{
    await deposit();const until=await f.escrow.validUntil(user().address);await(await f.token.connect(user()).approve(f.manifest.escrow,30)).wait();
    await(await f.escrow.connect(user()).deposit(30)).wait();assert.equal(await f.escrow.validUntil(user().address),until);
    await f.provider.send('evm_increaseTime',[365*86400+1]);await f.provider.send('evm_mine',[]);
    await rejectUnchanged(()=>f.escrow.connect(user()).deposit(30));await rejectUnchanged(()=>f.escrow.requestConsumption(user().address,id('expired')));
    await(await f.escrow.connect(user()).refund(3030)).wait();await covered();
  });
  check('SAFE-02: direct surplus does not become withdrawable',async()=>{
    await deposit();await(await f.token.connect(user()).transfer(f.manifest.escrow,90)).wait();assert.equal((await f.escrow.getAccounting()).surplus,90n);await rejectUnchanged(()=>f.escrow.withdraw(1));await covered();
  });
  check('FLOW-04: payout change preserves credit and logs exact operator',async()=>{
    await deposit();await(await f.escrow.connect(user()).confirmConsumption(await request())).wait();
    await(await f.escrow.setPayoutAddress(f.manifest.nextPayout)).wait();await(await f.escrow.withdraw(30)).wait();
    assert.equal(await f.token.balanceOf(f.manifest.nextPayout),30n);assert.equal(await f.escrow.balances(user().address),2970n);
    await rejectUnchanged(()=>f.escrow.setPayoutAddress(ZeroAddress));await rejectUnchanged(()=>f.escrow.setPayoutAddress(f.manifest.nextPayout));await covered();
  });
  check('SAFE-03: token transfer failures atomically roll back',async()=>{
    const a=readJSON('shared/artifacts/TestToken.json'),e=readJSON('shared/artifacts/GymEscrow.json');
    const token:any=await new ContractFactory(a.abi,a.bytecode,merchant()).deploy(user().address);await token.waitForDeployment();
    const escrow:any=await new ContractFactory(e.abi,e.bytecode,merchant()).deploy(await token.getAddress(),merchant().address,f.manifest.payout);await escrow.waitForDeployment();
    await(await token.connect(user()).approve(await escrow.getAddress(),3000)).wait();await(await token.configure(true,false,await escrow.getAddress())).wait();
    await assert.rejects(()=>escrow.connect(user()).deposit(3000));assert.equal(await escrow.totalUserCredit(),0n);assert.equal(await escrow.validUntil(user().address),0n);
    await(await token.configure(false,false,await escrow.getAddress())).wait();await(await escrow.connect(user()).deposit(3000)).wait();
    await(await token.configure(true,false,await escrow.getAddress())).wait();await assert.rejects(()=>escrow.connect(user()).refund(30));assert.equal(await escrow.balances(user().address),3000n);
  });
  check('SAFE-03: reentrant token callback cannot enter refund',async()=>{
    const a=readJSON('shared/artifacts/TestToken.json'),e=readJSON('shared/artifacts/GymEscrow.json');
    const token:any=await new ContractFactory(a.abi,a.bytecode,merchant()).deploy(user().address);await token.waitForDeployment();
    const escrow:any=await new ContractFactory(e.abi,e.bytecode,merchant()).deploy(await token.getAddress(),merchant().address,f.manifest.payout);await escrow.waitForDeployment();
    await(await token.connect(user()).approve(await escrow.getAddress(),3000)).wait();await(await token.configure(false,true,await escrow.getAddress())).wait();await(await escrow.connect(user()).deposit(3000)).wait();
    assert.equal(await token.callbackBlocked(),true);assert.equal(await escrow.balances(user().address),3000n);
  });
  check('QUANT/SAFE: deterministic operation sequence maintains invariant',async()=>{
    await deposit();for(let i=0;i<12;i++){await(await f.escrow.connect(user()).confirmConsumption(await request('sequence'+i))).wait();await covered();if(i%3===0){await(await f.escrow.withdraw(15)).wait();await covered();}}
    await(await f.escrow.connect(user()).refund(300)).wait();await covered();
  });
  check('SAFE: invalid amount/allowance/credit rejected',async()=>{
    for(const a of [0,1,31])await rejectUnchanged(()=>f.escrow.connect(user()).deposit(a));await rejectUnchanged(()=>f.escrow.connect(user()).deposit(3000));
    await deposit();for(const a of [0,3001])await rejectUnchanged(()=>f.escrow.connect(user()).refund(a));await rejectUnchanged(()=>f.escrow.withdraw(0));
  });
});
