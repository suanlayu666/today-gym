import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import {spawn,type ChildProcess} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {config,readJSON,writeJSON} from '../server/config.ts';
import {deploymentProof} from '../server/deployment-proof.ts';
import {deployLocal} from './deploy.ts';
import {deployFlow} from './deploy-flow.ts';
import type {Dataset} from '../shared/types.ts';
import {Store} from '../server/store.ts';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url))),runtime=path.join(root,'.runtime');
const socket=path.join(runtime,'service-control.sock'),lock=path.join(runtime,'services.lock');
const rpcUrl=new URL(config.localRpc),chainPort=Number(rpcUrl.port||80),webUrl='http://127.0.0.1:'+config.webPort,apiUrl='http://127.0.0.1:'+config.port;
const mode=process.argv[2]||'start';
const flowMode=process.argv.includes('--flow');
process.chdir(root);
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function json(url:string){const response=await fetch(url,{signal:AbortSignal.timeout(2000)});if(!response.ok)throw new Error('HTTP '+response.status);return response.json();}
async function localChain(){const response=await fetch(config.localRpc,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]}),signal:AbortSignal.timeout(2000)});const body=await response.json();if(body.error||Number(BigInt(body.result))!==31337)throw new Error('本地端口不是 chainId 31337，拒绝部署或复用。');}
async function portFree(port:number){return new Promise<boolean>(resolve=>{const s=net.createServer();s.once('error',()=>resolve(false));s.listen(port,'127.0.0.1',()=>s.close(()=>resolve(true)));});}
function requestControl(command:string){return new Promise<any>((resolve,reject)=>{const client=net.createConnection(socket);let data='';client.setTimeout(2500);client.on('connect',()=>client.end(command+'\n'));client.on('data',chunk=>data+=chunk);client.on('end',()=>{try{resolve(JSON.parse(data));}catch{reject(new Error('启动控制器响应无效。'));}});client.on('error',()=>reject(new Error('没有可连接的本项目启动控制器；不会按端口杀死其他进程。')));client.on('timeout',()=>{client.destroy();reject(new Error('启动控制器响应超时。'));});});}
async function doctor(){
  const checks:{name:string;status:string;detail?:unknown}[]=[];
  const major=Number(process.versions.node.split('.')[0]);checks.push({name:'Node',status:major>=24&&major%2===0?'pass':'fail',detail:process.versions.node});
  checks.push({name:'依赖与编译产物',status:['node_modules/vite/bin/vite.js','node_modules/hardhat/dist/src/cli.js','shared/artifacts/GymToken.json','shared/artifacts/GymEscrow.json'].every(f=>fs.existsSync(f))?'pass':'fail'});
  checks.push({name:'DeepSeek 服务端配置',status:config.llmKey&&config.llmEnabled?'configured':'missing',detail:{providerHost:new URL(config.llmBase).hostname,model:config.llmModel,secretDisplayed:false}});
  try{await localChain();checks.push({name:'本地链实际 chainId',status:'pass',detail:31337});}catch{checks.push({name:'本地链',status:'unavailable'});}
  const files=fs.existsSync('data/deployments')?fs.readdirSync('data/deployments').filter(f=>f.endsWith('.json')):[];
  for(const f of files){const d=readJSON('data/deployments/'+f) as Dataset;if(d.chainId!==31337)continue;try{const proof=await deploymentProof(d);checks.push({name:'部署 '+d.id,status:'pass',detail:proof});}catch{checks.push({name:'部署 '+d.id,status:'unverified',detail:'节点不可用、链已重启或部署清单与当前链不一致；不得展示为有效部署。'});}}
  try{const h=await json(apiUrl+'/api/health');checks.push({name:'API',status:'pass',detail:{modelConfigured:h.data?.modelConfigured,datasetCount:h.data?.datasets?.length}});}catch{checks.push({name:'API',status:'unavailable'});}
  try{const response=await fetch(webUrl,{signal:AbortSignal.timeout(2000)});checks.push({name:'网站',status:response.ok?'pass':'unavailable'});}catch{checks.push({name:'网站',status:'unavailable'});}
  writeJSON('artifacts/acceptance/environment-check.json',{at:new Date().toISOString(),checks,scope:'本机配置和可连接服务检查；不是公开链业务或最终系统验收'});
  console.log(JSON.stringify(checks,null,2));if(checks.some(c=>c.status==='fail'))process.exitCode=1;
}
async function start(){
  if(rpcUrl.protocol!=='http:'||!['127.0.0.1','localhost'].includes(rpcUrl.hostname)||rpcUrl.username||rpcUrl.password||rpcUrl.search||rpcUrl.pathname!=='/')throw new Error('一键启动只允许本机无凭证 HTTP RPC，不接管外部节点。');
  const ports=[chainPort,config.port,config.webPort,config.researchPort];if(new Set(ports).size!==4||ports.some(p=>!Number.isInteger(p)||p<1024||p>65535))throw new Error('RPC/API/网页/只读研究服务端口须互不相同且在 1024–65535 范围内。');
  fs.mkdirSync(runtime,{recursive:true,mode:0o700});
  let lockFd:number;try{lockFd=fs.openSync(lock,'wx',0o600);}catch{throw new Error('存在启动锁。先执行 npm run services:status；不会自动覆盖锁或杀死可能无关的进程。');}
  fs.writeFileSync(lockFd,JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}));fs.closeSync(lockFd);
  const children:{role:string;child:ChildProcess}[]=[],reused:string[]=[];let closing=false,ownsSocket=false,control:net.Server|undefined;
  const shutdown=async()=>{if(closing)return;closing=true;for(const {child} of children)if(child.exitCode===null&&child.pid)try{process.kill(-child.pid,'SIGTERM');}catch{}
    for(let i=0;i<30&&children.some(c=>c.child.exitCode===null);i++)await pause(100);
    for(const {child} of children)if(child.exitCode===null&&child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}
    control?.close();if(ownsSocket&&fs.existsSync(socket))fs.unlinkSync(socket);if(fs.existsSync(lock))fs.unlinkSync(lock);
    writeJSON('artifacts/acceptance/services-last-stop.json',{at:new Date().toISOString(),stoppedOwnedRoles:children.map(c=>c.role),untouchedReusedRoles:reused});console.log('已停止本次启动的服务；复用的外部服务未停止。');};
  process.once('SIGINT',()=>void shutdown());process.once('SIGTERM',()=>void shutdown());
  const launch=(role:string,args:string[])=>{const child=spawn(process.execPath,args,{cwd:root,detached:true,stdio:['ignore','pipe','pipe']});children.push({role,child});
    for(const stream of [child.stdout,child.stderr])if(stream)readline.createInterface({input:stream}).on('line',line=>console.log('['+role+'] '+line.replace(/sk-[A-Za-z0-9_-]+/g,'[REDACTED]').replace(/(Private Key:\s*)0x[0-9a-fA-F]{64}/gi,'$1[REDACTED]')));
    child.on('exit',(code)=>{if(!closing){console.error(role+' 已退出（'+code+'），停止本次拥有的其余服务。');process.exitCode=1;void shutdown();}});child.on('error',()=>{process.exitCode=1;void shutdown();});};
  const ready=async(fn:()=>Promise<unknown>)=>{for(let i=0;i<80;i++){if(closing)throw new Error('服务启动被中断。');try{await fn();return;}catch{await pause(250);}}throw new Error('服务未在启动预算内就绪。');};
  try{
    if(await portFree(chainPort)){launch('chain',['node_modules/hardhat/dist/src/cli.js','node','--network','local','--hostname','127.0.0.1','--port',String(chainPort)]);await ready(localChain);}else{await localChain();reused.push('chain');}
    if(flowMode)await deployFlow();
    else {
    const manifests=fs.existsSync('data/deployments')?fs.readdirSync('data/deployments').filter(f=>f.endsWith('.json')).map(file=>({file,ds:readJSON('data/deployments/'+file) as Dataset})).filter(x=>x.ds.chainId===31337):[];
    const invalid:typeof manifests=[];for(const m of manifests)try{await deploymentProof(m.ds);}catch{invalid.push(m);}
    if(invalid.length){
      if(!process.argv.includes('--renew-local'))throw new Error('本地链已重启或部署不一致。重新运行 npm run start -- --renew-local，会可恢复地归档失效的本地清单后部署；公开链清单与历史证据不删除。');
      if(reused.includes('chain'))throw new Error('拒绝归档外部运行链的清单。先由其拥有者停止；本脚本只重建自己刚启动的本地链。');
      if(!await portFree(config.port))throw new Error('API 仍在运行，不能同时归档清单。先由其拥有者停止。');
      const archive='data/archive/local-'+Date.now();fs.mkdirSync(archive,{recursive:true});for(const m of invalid)fs.renameSync('data/deployments/'+m.file,archive+'/'+m.file);
      const history=new Store();try{history.transaction(()=>{for(const m of invalid){for(const r of history.list('reports',m.ds.id))history.put('reports',{...r,status:'stale',limitations:[...r.limitations,'本地节点重启，部署清单已归档；这份报告仅适用于旧链实例。']});for(const j of history.list('jobs',m.ds.id))if(['running','queued'].includes(j.status))history.put('jobs',{...j,status:'failed',error:'旧本地链实例已归档。'});}});}finally{history.close();}
      console.log('失效本地部署清单已可恢复归档至 '+archive+'；原数据库历史证据保留。');
    }
    if(!manifests.length||invalid.length===manifests.length)await deployLocal();
    }
    if(await portFree(config.port)){launch('api',['--import','tsx','server/index.ts']);await ready(()=>json(apiUrl+'/api/config'));}else{const cfg=await json(apiUrl+'/api/config');if(cfg.data?.localRpc!==config.localRpc||!Array.isArray(cfg.data?.datasets))throw new Error('API 端口被不匹配服务占用。');if(flowMode&&(await json(apiUrl+'/api/health')).data?.workflow!=='direct-flow-v1')throw new Error('API 仍为旧流程，请由其拥有者重启。');reused.push('api');}
    if(await portFree(config.researchPort)){launch('research',['--import','tsx','server/research-entry.ts']);await ready(()=>json('http://127.0.0.1:'+config.researchPort+'/api/research/health'));}else{const r=await json('http://127.0.0.1:'+config.researchPort+'/api/research/health');if(r.data?.workflow!=='public-research-v1')throw new Error('只读研究服务端口被其他服务占用。');reused.push('research');}
    if(await portFree(config.webPort)){launch('web',['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(config.webPort),'--strictPort']);await ready(async()=>{const r=await fetch(webUrl,{signal:AbortSignal.timeout(2000)});if(!r.ok)throw new Error('Not ready');});}else{const r=await fetch(webUrl,{signal:AbortSignal.timeout(2000)});if(!(await r.text()).includes('今天链不练'))throw new Error('网站端口被其他页面占用。');reused.push('web');}
    if(fs.existsSync(socket))throw new Error('控制 socket 已存在，拒绝覆盖。');
    control=net.createServer(c=>{let input='';c.on('data',b=>{input+=b.toString();if(input.length>64)c.destroy();});c.on('end',()=>{const command=input.trim();c.end(JSON.stringify({ready:!closing,owned:children.map(c=>c.role),reused,command:command==='stop'?'stop':'status'}));if(command==='stop')void shutdown();});});
    await new Promise<void>((resolve,reject)=>{control!.once('error',reject);control!.listen(socket,()=>{ownsSocket=true;fs.chmodSync(socket,0o600);resolve();});});
    writeJSON('artifacts/acceptance/services-last-start.json',{at:new Date().toISOString(),owned:children.map(c=>c.role),reused,localChainId:31337,publicSigning:false});
    console.log('就绪：'+webUrl+' 。Ctrl+C 或 npm run stop；仅停止本次拥有的服务。');
  }catch(error){await shutdown();throw error;}
}
try{if(mode==='doctor')await doctor();else if(mode==='status'||mode==='stop')console.log(JSON.stringify(await requestControl(mode)));else if(mode==='start')await start();else throw new Error('Unknown services command');}
catch(error){console.error(error instanceof Error?error.message:'服务操作失败。');process.exitCode=1;}
