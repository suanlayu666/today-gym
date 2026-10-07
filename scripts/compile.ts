import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const solc = require('solc');
export function compile() {
  const sources = Object.fromEntries(fs.readdirSync('contracts').filter(f=>f.endsWith('.sol')).map(f=>[f,{content:fs.readFileSync(path.join('contracts',f),'utf8')}]));
  const settings = { optimizer: { enabled:true,runs:200 }, evmVersion:'shanghai', outputSelection: { '*': { '*':['abi','evm.bytecode.object','evm.deployedBytecode.object','evm.deployedBytecode.immutableReferences','metadata'] } } };
  const output=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources,settings}),{import:(file:string)=>{
    try { return { contents:fs.readFileSync(path.resolve('node_modules',file),'utf8') }; } catch { return {error:'Import not found: '+file}; }
  }}));
  const errors=(output.errors||[]).filter((e:{severity:string})=>e.severity==='error');
  if(errors.length) throw new Error(errors.map((e:{formattedMessage:string})=>e.formattedMessage).join('\n'));
  fs.mkdirSync('shared/artifacts',{recursive:true});
  for(const [source,contracts] of Object.entries(output.contracts) as [string,Record<string,any>][]) {
    if(!Object.hasOwn(sources,source)) continue;
    for(const [name,c] of Object.entries(contracts)) fs.writeFileSync(`shared/artifacts/${name}.json`,JSON.stringify({contractName:name,sourceName:source,compiler:solc.version(),settings,abi:c.abi,bytecode:'0x'+c.evm.bytecode.object,deployedBytecode:'0x'+c.evm.deployedBytecode.object,immutableReferences:c.evm.deployedBytecode.immutableReferences,metadata:c.metadata},null,2));
  }
  console.log('Compiled demo contracts using pinned solc '+solc.version());
}
if(process.argv[1]?.endsWith('compile.ts')) compile();
