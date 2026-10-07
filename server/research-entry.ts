import express from 'express';
import {config} from './config.ts';
import {Store} from './store.ts';
import {ChainService} from './chain.ts';
import {mountResearch} from './research-service.ts';
// Additive read-only service: no restart/reset of the running development chain.
const app=express(),store=new Store();app.use(express.json({limit:'8kb'}));
app.use((req,res,next)=>{
  if(![`127.0.0.1:${config.researchPort}`,`localhost:${config.researchPort}`,`127.0.0.1:${config.webPort}`,`localhost:${config.webPort}`].includes(req.headers.host||'')){res.status(403).json({error:{message:'仅允许本机访问。'}});return;}
  if(req.headers.origin&&![`http://127.0.0.1:${config.webPort}`,`http://localhost:${config.webPort}`].includes(req.headers.origin)){res.status(403).json({error:{message:'拒绝未知网页来源。'}});return;}
  res.setHeader('X-Content-Type-Options','nosniff');next();
});
mountResearch(app,store,new ChainService(store));
app.get('/api/research/health',(_req,res)=>res.json({data:{workflow:'public-research-v1',readOnly:true}}));
app.use((_error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(400).json({error:{message:'请求内容无效。'}}));
const server=app.listen(config.researchPort,'127.0.0.1',()=>console.log(`只读案例服务：http://127.0.0.1:${config.researchPort}`));
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>server.close(()=>{store.close();process.exit(0);}));
