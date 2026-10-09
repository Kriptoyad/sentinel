const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), ts = require('typescript');
const web3 = require('@solana/web3.js');
const idl = require('../src/idl/sentinel.json');
let calls=0, fail=false, requested=[];
class MockConnection {
 async getMultipleAccountsInfo(addresses) {
   calls++; requested=addresses;
   if(fail) throw new Error('429');
   return addresses.map((_,i)=>({owner: i===1 ? web3.SystemProgram.programId : new web3.PublicKey(idl.address),data:Buffer.from([i])}));
 }
}
const market = id=>({market_id:String(id),market_type:'Price',probability_bps:'5000',resolution_deadline:1791233577, total_yes_exposure:'0', total_no_exposure:'0',resolved:false});
const file=path.resolve('src/lib/onchain.ts');
const m=new Module(file,module);m.paths=module.paths;
m.require=name=>{
 if(name==='@solana/web3.js')return {...web3,Connection:MockConnection};
 if(name==='@/idl/sentinel.json')return idl;
 if(name==='./marketAccount')return {decodeMarket:b=>market(b[0]+1)};
 if(name==='./solana')return {PROGRAM_ID:new web3.PublicKey(idl.address),DEFAULT_RPC_URL:'http://mock',deriveMarketAddress:id=>new web3.PublicKey(Buffer.alloc(32,Number(id)))};
 return require(name);
};
m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,file);
(async()=>{
 const result=await m.exports.verifyMarkets([1,2,3,4].map(market));
 assert.equal(calls,1);assert.equal(requested.length,4);
 assert.equal(result[0].onchain_verified,true);
 assert.equal(result[1].onchain_verified,false);
 assert.equal(result[2].onchain_verified,true);
 fail=true;
 const unavailable=await m.exports.verifyMarkets([1,2,3,4].map(market));
 assert.ok(unavailable.every(m=>m.onchain_verified===false));
 assert.ok(unavailable.every(m=>m.chain_status.includes('trading disabled')));
 const before=calls;assert.deepEqual(await m.exports.verifyMarkets([]),[]);assert.equal(calls,before);
 console.log('PASS: four markets in one RPC; wrong-owner isolation; rate-limit disables trading; empty list makes no request');
})().catch(e=>{console.error(e);process.exitCode=1;});
