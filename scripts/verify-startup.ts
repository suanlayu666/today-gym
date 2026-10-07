import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {writeJSON} from '../server/config.ts';

// Cold start in a disposable copy on separately allocated loopback ports.
// Never stops/resets the user's running chain, copies keys, or calls an LLM.
// macOS Unix-domain socket paths have a short length limit; use a short temp
// root rather than its deeply nested per-user temporary directory.
const original=process.cwd(),copy=fs.mkdtempSync(path.join(process.platform==='darwin'?'/private/tmp':os.tmpdir(),'gym-start-'));
for(const name of ['server','scripts','shared','contracts','web','hardhat.config.ts','vite.config.ts','tsconfig.json','package.json','package-lock.json'])fs.cpSync(path.join(original,name),path.join(copy,name),{recursive:true});
fs.symlinkSync(path.join(original,'node_modules'),path.join(copy,'node_modules'),'dir');
const reservations:net.Server[]=[];
for(let i=0;i<3;i++){const server=net.createServer();await new Promise<void>((resolve,reject)=>{server.on('error',reject);server.listen(0,'127.0.0.1',resolve);});reservations.push(server);}
const ports=reservations.map(s=>(s.address() as net.AddressInfo).port);
await Promise.all(reservations.map(s=>new Promise<void>(resolve=>s.close(()=>resolve()))));
const env:NodeJS.ProcessEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(KEY|TOKEN|SECRET|PASSWORD|MNEMONIC|PRIVATE)/i.test(key)));
Object.assign(env,{LOCAL_RPC_URL:'http://127.0.0.1:'+ports[0],API_PORT:String(ports[1]),WEB_PORT:String(ports[2]),LLM_ENABLED:'false',DATABASE_PATH:path.join(copy,'data/startup.sqlite')});
const web='http://127.0.0.1:'+ports[2],results:unknown[]=[];let running:ChildProcess|undefined,output='';
async function waitExit(child:ChildProcess){if(child.exitCode!==null)return child.exitCode;return new Promise<number|null>(resolve=>child.once('close',resolve));}
async function request(endpoint:string,body?:unknown){const r=await fetch(web+'/api'+endpoint,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(4000)});assert.equal(r.status,200);return (await r.json() as any).data;}
async function stop(){
  if(!running)return;
  const child=spawn(process.execPath,['--import','tsx','scripts/services.ts','stop'],{cwd:copy,env,stdio:['ignore','pipe','pipe']});
  assert.equal(await waitExit(child),0);assert.equal(await waitExit(running),0);running=undefined;
  const saved=JSON.parse(fs.readFileSync(path.join(copy,'artifacts/acceptance/services-last-stop.json'),'utf8'));
  assert.deepEqual([...saved.stoppedOwnedRoles].sort(),['api','chain','web']);assert.deepEqual(saved.untouchedReusedRoles,[]);
}
async function start(renew=false){
  output='';running=spawn(process.execPath,['--import','tsx','scripts/services.ts','start',...(renew?['--renew-local']:[])],{cwd:copy,env,stdio:['ignore','pipe','pipe']});
  for(const stream of [running.stdout,running.stderr])stream!.on('data',chunk=>{output=(output+chunk.toString()).slice(-12000);});
  const deadline=Date.now()+40000;let ready=false;
  while(Date.now()<deadline){
    if(running.exitCode!==null)throw new Error('Cold startup exited: '+output.slice(-2000));
    try{const r=await fetch(web,{signal:AbortSignal.timeout(1000)});if(r.ok&&(await r.text()).includes('今天链不练')&&fs.existsSync(path.join(copy,'artifacts/acceptance/services-last-start.json'))){ready=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  assert.ok(ready,'Cold startup exceeded budget: '+output);
  const started=JSON.parse(fs.readFileSync(path.join(copy,'artifacts/acceptance/services-last-start.json'),'utf8'));
  assert.deepEqual([...started.owned].sort(),['api','chain','web']);assert.deepEqual(started.reused,[]);
  const cfg=await request('/config');assert.equal(cfg.localRpc,env.LOCAL_RPC_URL);assert.equal(cfg.datasets.length,1);
  const ds=cfg.datasets[0];assert.equal(ds.chainId,31337);
  const cp=await request('/sync',{datasetId:ds.id});assert.equal(cp.status,'ok');assert.equal(cp.coverageComplete,true);
  const overview=await request('/overview?datasetId='+ds.id);assert.equal(overview.snapshot.assets,'0');assert.equal(overview.snapshot.userCredit,'0');
  const user=await request('/users/'+ds.users[0]+'?datasetId='+ds.id);assert.equal(user.wallet,'30000');assert.equal(user.balance,'0');
  const denied=await fetch(web+'/api/config',{headers:{Origin:'https://untrusted.invalid'}});assert.equal(denied.status,403);
  return ds.id as string;
}
try{
  const first=await start();results.push({name:'fresh project/data cold start, deploy, frontend proxy, sync and balances',passed:true,datasetId:first});
  await stop();results.push({name:'stop only all three owned isolated services',passed:true});
  // One actual restart, not repeated EVM snapshot/regression tests.
  fs.unlinkSync(path.join(copy,'artifacts/acceptance/services-last-start.json'));
  const second=await start(true);assert.notEqual(second,first);
  const archives=fs.readdirSync(path.join(copy,'data/archive'));assert.ok(archives.length);
  const archived=JSON.parse(fs.readFileSync(path.join(copy,'data/archive',archives[0],'local.json'),'utf8'));assert.equal(archived.id,first);
  results.push({name:'restart new local node, recoverably archive stale manifest, deploy new active case',passed:true,oldDatasetId:first,newDatasetId:second});
  await stop();
  console.log(JSON.stringify({passed:true,checks:results.length,originalChainUntouched:true}));
}catch(error){results.push({name:'startup smoke failed',passed:false,error:error instanceof Error?error.message:'unknown'});console.error(JSON.stringify(results.at(-1)));process.exitCode=1;}
finally{
  if(running)try{await stop();}catch{running.kill('SIGTERM');}
  writeJSON(path.join(original,'artifacts/acceptance/startup-smoke.json'),{at:new Date().toISOString(),passed:results.length===3&&(results as any[]).every(r=>r.passed),results,isolatedCopy:copy,ports,scope:'Same project code, existing installed dependencies reused. New isolated local node/data/API/web and one restart; no LLM/private keys/public transactions and no original-chain rollback. Not a clean dependency download or Sepolia verification.'});
}
