import express from 'express';
import fs from 'node:fs';
import {isAddress} from 'ethers';
import {z} from 'zod';
import {config,readJSON} from './config.ts';
import {Store} from './store.ts';
import {ChainService} from './chain.ts';
import {Investigator,reportMarkdown} from './agent.ts';
import {automaticInvestigation} from './monitor.ts';
import {pendingRequests,confirmedToday} from '../shared/business.ts';
import type {Dataset,Report} from '../shared/types.ts';
import {mountFlow} from './flow-service.ts';

const store=new Store(),chain=new ChainService(store),agent=new Investigator(store,chain),app=express();
app.use(express.json({limit:'64kb'}));
app.use((req,res,next)=>{
  if(![`127.0.0.1:${config.port}`,`localhost:${config.port}`,`127.0.0.1:${config.webPort}`,`localhost:${config.webPort}`].includes(req.headers.host||'')){res.status(403).json({error:{code:'HOST',message:'仅允许本机访问。'}});return;}
  if(req.headers.origin&&![`http://127.0.0.1:${config.webPort}`,`http://localhost:${config.webPort}`].includes(req.headers.origin)){res.status(403).json({error:{code:'ORIGIN',message:'拒绝未知网页来源。'}});return;}
  res.setHeader('X-Content-Type-Options','nosniff');next();
});
let activeDatasetIds=new Set<string>();
function loadDatasets(){const active=new Set<string>();if(fs.existsSync('data/deployments'))for(const file of fs.readdirSync('data/deployments').filter(f=>f.endsWith('.json'))){const d=readJSON('data/deployments/'+file);if(![31337,11155111].includes(d.chainId)||d.adapter!=='gym'||!isAddress(d.token)||!isAddress(d.escrow))continue;store.put('datasets',d);active.add(d.id);}if(fs.existsSync('cases/mainnet'))for(const file of fs.readdirSync('cases/mainnet').filter(f=>f.endsWith('.manifest.json'))){const d=readJSON('cases/mainnet/'+file);store.put('datasets',d);active.add(d.id);}activeDatasetIds=active;}
const activeDatasets=()=>store.list<Dataset>('datasets').filter(d=>activeDatasetIds.has(d.id));
loadDatasets();
for(const job of store.list('jobs'))if(['running','queued'].includes(job.status))store.put('jobs',{...job,status:'failed',error:'服务重启中断任务，可重新发起。'});
const ds=(req:express.Request)=>{const value=store.get<Dataset>('datasets',String(req.query.datasetId||req.body?.datasetId||''));if(!value||!activeDatasetIds.has(value.id))throw new Error('请选择有效数据集。');return value;};
const route=(fn:(req:express.Request,res:express.Response)=>Promise<unknown>|unknown)=>(req:express.Request,res:express.Response)=>Promise.resolve().then(()=>fn(req,res)).catch(()=>res.status(400).json({error:{code:'REQUEST_FAILED',message:'请求失败：检查网络、参数或数据范围。'}}));
const ok=(res:express.Response,data:unknown)=>res.json({data});
app.get('/api/health',route(async(req,res)=>ok(res,{workflow:'direct-flow-v1',modelConfigured:!!config.llmKey&&config.llmEnabled,datasets:activeDatasets().map(d=>({id:d.id,...store.checkpoint(d.id)}))})));
app.get('/api/config',route((req,res)=>ok(res,{datasets:activeDatasets(),localRpc:config.localRpc,tokenAbi:readJSON('shared/artifacts/GymToken.json').abi,escrowAbi:readJSON('shared/artifacts/GymEscrow.json').abi,localTestWalletEnabled:true})));
app.post('/api/sync',route(async(req,res)=>{loadDatasets();return ok(res,await chain.sync(ds(req)));}));
app.get('/api/overview',route(async(req,res)=>{const d=ds(req),checkpoint=store.checkpoint(d.id),events=store.events(d.id);return ok(res,{dataset:d,checkpoint,snapshot:d.adapter==='gym'&&checkpoint?.blockNumber!==undefined?await chain.snapshot(d,checkpoint.blockNumber):null,events:events.slice(-100),totalEventCount:events.length,displayEventLimit:100,alerts:store.list('alerts',d.id),reports:store.list('reports',d.id),latestJob:store.list('jobs',d.id)[0]??null,backgroundMonitoring:config.autoInvestigation&&!!config.llmKey&&config.llmEnabled,businessSummary:d.adapter==='gym'?{todayRevenue:confirmedToday(events),pending:pendingRequests(events)}:null});}));
app.get('/api/users/:address',route(async(req,res)=>{if(!isAddress(String(req.params.address)))throw new Error('Bad address');return ok(res,await chain.user(ds(req),String(req.params.address)));}));
app.get('/api/events',route((req,res)=>{const d=ds(req),limit=Math.min(200,Math.max(1,Number(req.query.limit||100)));return ok(res,store.events(d.id).slice(-limit));}));
app.get('/api/alerts',route((req,res)=>ok(res,store.list('alerts',ds(req).id))));
app.post('/api/investigations',route((req,res)=>{const input=z.object({datasetId:z.string(),question:z.string().min(1).max(1000)}).strict().parse(req.body);res.status(202);return ok(res,agent.start(ds(req),input.question));}));
app.get('/api/investigations/:id',route((req,res)=>{const job=store.get('jobs',String(req.params.id));if(!job){res.status(404);return ok(res,null);}return ok(res,job);}));
app.get('/api/reports/:id/export',route((req,res)=>{const r=store.get<Report>('reports',String(req.params.id));if(!r)throw new Error('Not found');res.setHeader('Content-Disposition',`attachment; filename="report-${r.id}.${req.query.format==='md'?'md':'json'}"`);if(req.query.format==='md')return res.type('text/markdown').send(reportMarkdown(r));return ok(res,r);}));
app.get('/api/reports/:id',route((req,res)=>{const r=store.get('reports',String(req.params.id));if(!r){res.status(404);return ok(res,null);}return ok(res,r);}));
app.get('/api/evidence/:id',route((req,res)=>{const e=store.get('evidence',String(req.params.id));if(!e){res.status(404);return ok(res,null);}return ok(res,e);}));
const stopFlow=mountFlow(app);
app.use((error:unknown,req:express.Request,res:express.Response,next:express.NextFunction)=>res.status(400).json({error:{code:'BAD_BODY',message:'请求内容无效。'}}));
async function monitorGym(d:Dataset){
  const checkpoint=await chain.sync(d);
  const request=automaticInvestigation(d,checkpoint,store.events(d.id),store.list('alerts',d.id),store.list<Report>('reports',d.id),store.list('jobs',d.id),config.autoInvestigation&&!!config.llmKey&&config.llmEnabled);
  if(request)agent.start(d,request.question,{automaticKey:request.automaticKey});
}
const timer=setInterval(()=>{loadDatasets();if(!fs.existsSync('data/flow/deployment-local.json'))for(const d of activeDatasets().filter(d=>d.adapter==='gym'))void monitorGym(d).catch(()=>{});},5000);
timer.unref();
const server=app.listen(config.port,'127.0.0.1',()=>console.log(`API ready: http://127.0.0.1:${config.port}`));
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{clearInterval(timer);stopFlow();server.close(()=>{store.close();process.exit(0);});});
