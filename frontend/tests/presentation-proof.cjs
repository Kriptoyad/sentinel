const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { createHash } = require('node:crypto');
const cache = new Map();
function load(file) {
 if(cache.has(file)) return cache.get(file);
 const m={exports:{}};
 const code=ts.transpileModule(fs.readFileSync('src/lib/'+file+'.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 vm.runInNewContext(code,{module:m,exports:m.exports,require:p=>p.startsWith('./')?load(p.slice(2)):require(p),console,Date,BigInt});
 cache.set(file,m.exports);return m.exports;
}
const {decisionProof}=load('decisionProof');
const {marketReading,marketTitle,defaultArenaMarket}=load('marketPresentation');
const text='Türkçe gerekçe: ı ş ü 🛡️';
const d={reasoning:text,reasoning_hash:createHash('sha256').update(text,'utf8').digest('hex'),reasoning_verified:false};
assert.equal(decisionProof(d),'verified');
assert.equal(decisionProof({...d,reasoning:text+' ',reasoning_verified:true}),'mismatch');
assert.equal(decisionProof({...d,reasoning:null}),'missing');
assert.equal(decisionProof({...d,reasoning_hash:'0'.repeat(64),reasoning_verified:true}),'unverified');
assert.equal(decisionProof({...d,reasoning_hash:'invalid'}),'unverified');
const market={market_id:'4',resolved:true,probability_bps:'5000',resolution_outcome:false,finalized_at:100,resolution_deadline:10};
assert.equal(marketReading(market,101).value,'NO');
assert.equal(marketReading(market,101).final,true);
assert.equal(marketReading(market,99).final,false);
assert.equal(marketReading({...market,resolution_outcome:null},101).value,'BELİRSİZ');
assert.equal(marketReading({...market,resolved:false,probability_bps:'2844'},5).value,'28.44%');
assert.equal(marketTitle("[DEMO] SOL, resolution_deadline anında $250 üzerinde mi? (canlı sunum demosu, ~90 dk vadeli)"),'SOL, son tarih anında $250 üzerinde mi?');
assert.equal(market.question,undefined); // Presentation helpers never mutate market metadata.
const groups=[
 {market:{...market,market_id:'1',resolved:false,resolution_deadline:10},decisions:[{ts:999}],source:'api'},
 {market:{...market,market_id:'2',resolved:false,resolution_deadline:200},decisions:[{ts:90}],source:'api'},
 {market:{...market,market_id:'3'},decisions:[{ts:1000}],source:'api'}
];
assert.equal(defaultArenaMarket(groups,100),'2');
assert.equal(defaultArenaMarket([],100),'');
assert.equal(defaultArenaMarket(groups,300),'3');
console.log('PASS: exact text hashes, untrusted backend flags, final/provisional outcomes, clean titles, open-market selection');
