const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { hashReasoning, verification, attachReasoning, expiryState } = require('../sentinel-integrity.cjs');
const text = 'Mainnet ortalama TPS: 4664; Türkçe: ı, ş, ü 🛡️';
const entry = () => ({market_id:'2',agent_id:2,ts:100,reasoning:text,signature:'tx-A',used:false});
const decision = () => ({agent_id:2,ts:108,reasoning:null,reasoning_hash:hashReasoning(text),signature:'tx-A'});
test('UTF-8 exact bytes: spaces and Unicode normalization change the hash', () => {
 assert.equal(hashReasoning('abc'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
 assert.notEqual(hashReasoning(text),hashReasoning(text+' '));
 assert.notEqual(hashReasoning('é'),hashReasoning('e\u0301'));
});
test('POST before event attaches once even when clocks differ substantially', () => {
 const e=entry(), d=decision();d.ts=999;
 attachReasoning(d,[e],'2');assert.equal(verification(d),'verified');assert.equal(e.used,true);
 const other=decision();attachReasoning(other,[e],'2');assert.equal(other.reasoning,null);
});
test('event before POST verifies text', () => {
 const d=decision();assert.equal(verification(d),'missing');attachReasoning(d,[entry()],'2');assert.equal(verification(d),'verified');
});
test('wrong text, signature, market and agent never attach', () => {
 for (const changes of [{reasoning:text+' '},{signature:'tx-B'},{market_id:'1'},{agent_id:3}]) {
  const d=decision();attachReasoning(d,[{...entry(),...changes}],'2');assert.equal(d.reasoning,null);
 }
});
test('legacy zero hashes stay unverified; tampered hashed text is mismatch', () => {
 const d={...decision(),reasoning_hash:'0'.repeat(64),signature:undefined};
 attachReasoning(d,[{...entry(),signature:undefined}],'2');assert.equal(d.reasoning,text);assert.equal(verification(d),'unverified');
 assert.equal(verification({...decision(),reasoning:'tampered'}),'mismatch');
});
test('expiry uses exact 300-second boundary and supports large i64 values', () => {
 const deadline=9007199254740993n;
 assert.equal(expiryState(deadline,deadline-1n),'open');
 assert.equal(expiryState(deadline,deadline),'grace');
 assert.equal(expiryState(deadline,deadline+299n),'grace');
 assert.equal(expiryState(deadline,deadline+300n),'expired');
});
const root=path.join(__dirname,'..');
const crank=fs.readFileSync(path.join(root,'sentinel-crank-bot-v2.js'),'utf8');
test('actual crank sends UTF-8 hash bytes and same text with transaction identity',async()=>{
 const start=crank.indexOf('async function logAgentDecision('),end=crank.indexOf('\nasync function main()',start);
 let args,posted;
 const context={Buffer,hashReasoning,scoreToSideAndConfidence:()=>({side:{yes:{}},confidenceBps:6000}),postReasoning:async(...a)=>posted=a,console:{log(){},error(e){throw Error(e)}}};
 vm.createContext(context);vm.runInContext(crank.slice(start,end)+'\nthis.log=logAgentDecision;',context);
 const program={methods:{logAgentDecision(...a){args=a;return{accounts(){return{rpc:async()=> 'tx-A'}}}}}};
 await context.log(program,{getTransaction:async()=>({blockTime:100})},{publicKey:'wallet'},'market',2,{id:2,name:'Chain Watcher'},0.6,text);
 assert.equal(Buffer.from(args[3]).toString('hex'),hashReasoning(text));assert.equal(posted[3],text);assert.equal(posted[4],'tx-A');
});
test('actual tick skips grace/resolved markets and resolves only after grace',async()=>{
 const a=crank.indexOf('  async function runTick()'),b=crank.indexOf('\n  await tick();',a);
 const clock=Buffer.alloc(40);clock.writeBigInt64LE(1300n,32);
 const markets=[
  {publicKey:'expired',account:{marketId:1,resolutionDeadline:1000n,resolved:false}},
  {publicKey:'grace',account:{marketId:2,resolutionDeadline:1001n,resolved:false}},
  {publicKey:'resolved',account:{marketId:3,resolved:true}}
 ];
 const calls=[];
 const context={tickCounter:0,NEWS_REFRESH_TICKS:5,cachedNewsSignal:{},fetchNewsSignal:async()=>({}),fetchChainSignal:async()=>({}),fetchSolPrice:async()=>200,mainnetConnection:{},connection:{getAccountInfo:async()=>({data:clock})},SYSVAR_CLOCK_PUBKEY:'clock',expiryState,wallet:{publicKey:'caller'},program:{account:{market:{all:async()=>markets,fetch:async()=>({finalizedAt:4900n})}},methods:{resolveExpired:()=>({accounts:a=>({rpc:async()=>{calls.push(a.market);return'sig'}})}),updateProbability:()=>{throw Error('Expired market must not update')} }},console:{log(){},error(e){throw Error(e)}}};
 vm.createContext(context);vm.runInContext(crank.slice(a,b)+'\nthis.run=runTick;',context);await context.run();assert.deepEqual(calls,['expired']);
});
test('actual decoder excludes foreign CPI events and accepts Sentinel events',()=>{
 const source=fs.readFileSync(path.join(root,'scripts/sentinel-indexer-api-v2.js'),'utf8');
 const a=source.indexOf('function decodeEventsFromLogs('),b=source.indexOf('\nconst RPC_URL',a);
 const disc=Buffer.alloc(8,1),data=Buffer.concat([disc,Buffer.from('body')]).toString('base64');
 const context={Buffer,PROGRAM_ID:{toBase58:()=> 'sentinel'},EVENT_DISCRIMINATORS:{AgentDecisionLogged:disc},decodeEventBody:()=>({market:'m'}),console};
 vm.createContext(context);vm.runInContext(source.slice(a,b)+'\nthis.decode=decodeEventsFromLogs;',context);
 const events=context.decode(['Program sentinel invoke [1]','Program foreign invoke [2]',`Program data: ${data}`,'Program foreign success',`Program data: ${data}`,'Program sentinel success',`Program data: ${data}`]);
 assert.equal(events.length,1);
});
