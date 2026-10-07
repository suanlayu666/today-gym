import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {config,readJSON,writeJSON} from '../server/config.ts';
import {Store} from '../server/store.ts';

// This runner does not generate new AI reports, submit public transactions,
// restart services, or turn previously saved browser observations into new ones.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
process.chdir(root);
const options=new Set(process.argv.slice(2));
for(const option of options)if(!['--online','--contracts'].includes(option))throw new Error('Use only --online and/or --contracts');
const startedAt=new Date().toISOString();
const results:{name:string;status:'passed'|'failed'|'not-run';exitCode?:number|null;output?:string;durationMs?:number}[]=[];
const redact=(value:string)=>{
  let clean=config.llmKey?value.replaceAll(config.llmKey,'[REDACTED]'):value;
  clean=clean.replace(/sk-[A-Za-z0-9_-]+/g,'[REDACTED]');
  // Dedicated test signing credentials must not appear in a subprocess error.
  if(fs.existsSync('.runtime/sepolia-wallets.json')){
    const wallets=JSON.parse(fs.readFileSync('.runtime/sepolia-wallets.json','utf8'));
    for(const account of Object.values(wallets.accounts??{}) as {privateKey?:string}[])
      if(account.privateKey)clean=clean.replaceAll(account.privateKey,'[REDACTED]');
  }
  return clean;
};
async function run(name:string,args:string[]){
  console.log('[验收] '+name);
  const start=Date.now();
  const outcome=await new Promise<{exitCode:number|null;output:string}>(resolve=>{
    const child=spawn(process.execPath,args,{cwd:root,stdio:['ignore','pipe','pipe'],timeout:180000});
    let output='';
    const capture=(chunk:Buffer)=>{output=(output+chunk.toString()).slice(-256000);};
    child.stdout.on('data',capture);child.stderr.on('data',capture);
    child.on('error',error=>{output+='\n'+error.message;});
    child.on('close',code=>resolve({exitCode:code,output:redact(output)}));
  });
  results.push({name,status:outcome.exitCode===0?'passed':'failed',...outcome,durationMs:Date.now()-start});
  console.log('[结果] '+name+' · '+(outcome.exitCode===0?'通过':'失败'));
  if(outcome.exitCode!==0)console.log(outcome.output.slice(-4000));
}
await run('TypeScript',['node_modules/typescript/bin/tsc','--noEmit']);
await run('网页生产构建',['node_modules/vite/bin/vite.js','build']);
await run('分析与数据工具单元测试（synthetic/mock）',['--import','tsx','--test','tests/analysis.test.ts','tests/data-agent.test.ts']);
if(options.has('--contracts')){
  const store=new Store();
  const busy=store.list('jobs').some(job=>['running','queued'].includes(job.status));
  store.close();
  if(busy){
    results.push({name:'本地 EVM 合约测试',status:'not-run',output:'存在活动调查；快照回滚可能影响调查，未执行。请先等待任务结束，并勿在测试期间发起调查或网页交易。'});
  }else {
    await run('本地 EVM 合约测试（会快照回滚；不覆盖公开链）',['--import','tsx','--test','tests/contracts.test.ts']);
    await run('回滚后本地索引恢复与截止块核对（不发送交易）',['--import','tsx','scripts/sync-local.ts']);
  }
}
await run('主网保存数据离线复算',['--import','tsx','scripts/verify-mainnet.ts']);
await run('四份当前报告与真实模型原稿核对',['--import','tsx','scripts/verify-reports.ts']);
await run('实际 API 与导出核对',['--import','tsx','scripts/verify-api.ts']);
await run('既有网页拒绝取消交易的链上核对（不是重新操作网页）',['--import','tsx','scripts/verify-browser-business.ts']);
if(options.has('--online'))await run('主网只读在线样本复核',['--import','tsx','scripts/verify-mainnet.ts','--online']);
const passed=results.every(result=>result.status==='passed');
const latest='artifacts/acceptance/acceptance-suite.json';
if(fs.existsSync(latest)){
  const previous=readJSON(latest);
  writeJSON('artifacts/acceptance/suite-runs/'+String(previous.startedAt).replace(/[^0-9A-Za-z.-]/g,'_')+'.json',previous);
}
const artifact={
  startedAt,finishedAt:new Date().toISOString(),scopePassed:passed,projectP0Complete:false,
  options:[...options],results,
  limitations:[
    '通过仅指本次列出的检查，不表示执行方案所有 P0 项通过。',
    '不发送公开网络交易、不生成新模型报告、不申请资源、不重启服务。',
    '报告检查依据已保存的实际数据与模型响应；自然语言语义仍可能存在残余错误。',
    '网页链上核对使用已有实际浏览器交易，不是本次重新进行浏览器端到端操作。',
    'Sepolia 公开业务、完整浏览器/故障/安全回归和冷启动复现尚需独立验收。',
    '可选本地合约测试会改变测试链高度；不要同时发起调查或交易。'
  ]
};
writeJSON('artifacts/acceptance/suite-runs/'+startedAt.replace(/[^0-9A-Za-z.-]/g,'_')+'.json',artifact);
writeJSON(latest,artifact);
console.log(JSON.stringify({scopePassed:passed,projectP0Complete:false,checks:results.length,artifact:'artifacts/acceptance/acceptance-suite.json'}));
if(!passed)process.exitCode=1;
