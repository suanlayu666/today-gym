import fs from 'node:fs';
import path from 'node:path';
for(const file of ['.env.local','../.env.local']) {
  if(fs.existsSync(file)) { process.loadEnvFile(path.resolve(file)); break; }
}
function approvedAutoInvestigation(){
  if(process.env.AUTO_INVESTIGATION!==undefined)return process.env.AUTO_INVESTIGATION==='true';
  try{return JSON.parse(fs.readFileSync('data/runtime-settings.json','utf8')).automaticInvestigation===true;}catch{return false;}
}
export const config={
  port:Number(process.env.API_PORT||3001), webPort:Number(process.env.WEB_PORT||5173), researchPort:Number(process.env.RESEARCH_PORT||3002), localRpc:process.env.LOCAL_RPC_URL||'http://127.0.0.1:8545',
  mainnetRpc:process.env.MAINNET_RPC_URL||'https://ethereum.publicnode.com',
  mainnetFallbackRpc:process.env.MAINNET_FALLBACK_RPC_URL||'https://eth.drpc.org/',
  sepoliaRpc:process.env.SEPOLIA_RPC_URL||'https://ethereum-sepolia.publicnode.com',
  llmBase:process.env.LLM_BASE_URL||'https://api.deepseek.com', llmModel:process.env.LLM_MODEL||'deepseek-flash',
  llmKey:process.env.LLM_API_KEY||'', llmEnabled:process.env.LLM_ENABLED!=='false',
  // Automatic third-party data transmission requires a separate explicit opt-in.
  autoInvestigation:approvedAutoInvestigation(),
};
export function readJSON<T=any>(file:string):T {return JSON.parse(fs.readFileSync(file,'utf8'));}
export function writeJSON(file:string,data:unknown) { fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(data,(_,v)=>typeof v==='bigint'?v.toString():v,2)); }
