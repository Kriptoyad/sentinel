const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const {PublicKey} = require('@solana/web3.js');
const idl = require('../src/idl/sentinel.json');
const Module = require('node:module');
const filename = require('node:path').resolve('src/lib/marketAccount.ts');
const loaded = new Module(filename, module);
loaded.paths = module.paths;
loaded.require = name => name === '@/idl/sentinel.json' ? idl : require(name);
loaded._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,filename);
const {decodeMarket} = loaded.exports;
const u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
const i64=n=>{const b=Buffer.alloc(8);b.writeBigInt64LE(BigInt(n));return b;};
const key=new PublicKey('98svFeyTKoL8LWG6q3Fh3KTiAYeFnhFiaNaWmoEhZF35');
const mint=new PublicKey('6jnypkLny5TGDrJLw2vB7fTDu6iKRrZXmdmfKpd8JNC8');
const fixture=resolved=>Buffer.concat([
 Buffer.from(idl.accounts.find(a=>a.name==='Market').discriminator),u64(4),Buffer.from([1]),Buffer.alloc(32),Buffer.alloc(4),
 key.toBuffer(),mint.toBuffer(),key.toBuffer(),key.toBuffer(),Buffer.from([0x88,0x13]),i64(-12),i64(1790720000),
 u64('9007199254740993'),u64(30000000),Buffer.from([resolved?1:0]),
 resolved?Buffer.from([1,0]):Buffer.from([0]),resolved?Buffer.concat([Buffer.from([1]),i64(1790720331)]):Buffer.from([0]),
 resolved?Buffer.concat([Buffer.from([1]),i64(1790723931)]):Buffer.from([0]),i64(1790639120),Buffer.from([255])]);
const settled=decodeMarket(fixture(true));
assert.equal(settled.total_yes_exposure,'9007199254740993');
assert.equal(settled.resolution_outcome,false);
assert.equal(settled.finalized_at,1790723931);
assert.equal(settled.collateral_mint,mint.toBase58());
assert.equal(settled.resolution_deadline,1790639120);
const active=decodeMarket(fixture(false));
assert.equal(active.finalized_at,null);
assert.equal(active.resolution_deadline,1790639120);
assert.throws(()=>decodeMarket(fixture(true).subarray(0,100)),/Truncated/);
const bad=fixture(true);bad[0]^=1;assert.throws(()=>decodeMarket(bad),/discriminator/);
const kind=fixture(true);kind[16]=9;assert.throws(()=>decodeMarket(kind),/market type/);
console.log('PASS: exact u64, optional settlement fields, mint, deadline, truncated/wrong accounts');
