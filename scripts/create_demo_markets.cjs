const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { Program, AnchorProvider, BN } = require('@anchor-lang/core');
const { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint, createAssociatedTokenAccount, getAssociatedTokenAddressSync, mintTo,
} = require('@solana/spl-token');

const PROGRAM_ID = new PublicKey('3PA87yNfZD3DptejAafT2ovehCkh3xo8DhUVQoyWTw2P');
const SPECS = [
  {
    id: 1n,
    marketType: { price: {} },
    market_type: 'Price',
    question: 'Will SOL be above $250 at the deadline?',
    resolution_rules: 'At the exact UTC deadline, the oracle authority attests whether its designated SOL/USD reading is above $250. The program does not verify a Pyth price update.',
    initialProbability: 6200,
    days: 7,
  },
  {
    id: 2n,
    marketType: { risk: {} },
    market_type: 'Risk',
    question: 'Will Demo Protocol have a confirmed exploit within 30 days?',
    resolution_rules: 'At the exact UTC deadline, the oracle authority attests whether a publicly documented Demo Protocol exploit was confirmed by then. This is an illustrative market, not a real protocol assessment or insurance.',
    initialProbability: 800,
    days: 30,
  },
];

function deriveMarket(id) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(id);
  return PublicKey.findProgramAddressSync([Buffer.from('market'), bytes], PROGRAM_ID)[0];
}
function derivePool(market) {
  return PublicKey.findProgramAddressSync([Buffer.from('pool'), market.toBuffer()], PROGRAM_ID)[0];
}
function metadataUri(questionHash) {
  const body = JSON.stringify({ qh: questionHash.toString('hex'), m: 'deadline_snapshot' });
  const uri = `data:application/json;base64,${Buffer.from(body).toString('base64')}`;
  if (Buffer.byteLength(uri, 'utf8') > 200) throw new Error('Metadata URI is over contract limit');
  return uri;
}

async function main() {
  process.env.ANCHOR_PROVIDER_URL ||= 'https://api.devnet.solana.com';
  process.env.ANCHOR_WALLET ||= path.join(process.env.HOME, '.config/solana/id.json');
  const provider = AnchorProvider.env();
  if (!/devnet/i.test(provider.connection.rpcEndpoint)) throw new Error('Provider must point to Devnet');
  const walletPath = process.env.ANCHOR_WALLET;
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, 'utf8'))));
  const idlPath = path.join(process.cwd(), 'target/idl/sentinel.json');
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
  if (idl.address !== PROGRAM_ID.toBase58()) throw new Error('Generated IDL address does not match Sentinel program');
  const program = new Program(idl, provider);
  const balance = await provider.connection.getBalance(payer.publicKey, 'confirmed');
  if (balance < 80_000_000) throw new Error(`Need at least 0.08 Devnet SOL for setup; current balance is ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  const derived = SPECS.map(spec => ({ ...spec, market: deriveMarket(spec.id) }));
  for (const spec of derived) {
    const existing = await provider.connection.getAccountInfo(spec.market, 'confirmed');
    if (existing) throw new Error(`Market ID ${spec.id} already exists at ${spec.market}; refusing to overwrite`);
  }

  console.log(`Creator/oracle/dispute authority: ${payer.publicKey.toBase58()}`);
  console.log(`Available Devnet SOL: ${(balance / LAMPORTS_PER_SOL).toFixed(4)}`);
  const mint = await createMint(provider.connection, payer, payer.publicKey, null, 6);
  const userTokenAccount = await createAssociatedTokenAccount(provider.connection, payer, mint, payer.publicKey);
  await mintTo(provider.connection, payer, mint, userTokenAccount, payer, 1_000_000_000_000n);
  console.log(`Demo collateral mint (6 decimals): ${mint.toBase58()}`);
  console.log(`Minted test-only balance: 1,000,000 tokens to ${userTokenAccount.toBase58()}`);

  const created = [];
  for (const spec of derived) {
    const market = spec.market;
    const pool = derivePool(market);
    const marketVault = getAssociatedTokenAddressSync(mint, market, true);
    const poolVault = getAssociatedTokenAddressSync(mint, pool, true);
    const questionHash = crypto.createHash('sha256').update(spec.question, 'utf8').digest();
    const deadline = Math.floor(Date.now() / 1000) + spec.days * 86400;
    await program.methods.initializeMarket(
      new BN(spec.id.toString()), spec.marketType, Array.from(questionHash),
      metadataUri(questionHash), spec.initialProbability,
      payer.publicKey, payer.publicKey, new BN(deadline),
    ).accountsStrict({
      creator: payer.publicKey,
      market,
      collateralMint: mint,
      marketVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).rpc();
    const poolDisclaimer = crypto.createHash('sha256')
      .update('This is not insurance. Any payout is limited to funds actually deposited in the voluntary pool.', 'utf8')
      .digest();
    await program.methods.initPool(Array.from(poolDisclaimer)).accountsStrict({
      authority: payer.publicKey,
      market,
      pool,
      collateralMint: mint,
      poolVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).rpc();
    created.push({
      market_id: spec.id.toString(), market_type: spec.market_type,
      question: spec.question, resolution_rules: spec.resolution_rules,
      probability_bps: String(spec.initialProbability), probability_history: [],
      total_yes_exposure: '0', total_no_exposure: '0', resolved: false,
      resolution_methodology: 'deadline_snapshot', resolution_deadline: deadline,
      dispute_authority: payer.publicKey.toBase58(), metadata_uri: metadataUri(questionHash),
      question_hash: questionHash.toString('hex'), market_address: market.toBase58(),
      pool_address: pool.toBase58(), market_vault: marketVault.toBase58(),
      pool_vault: poolVault.toBase58(), collateral_mint: mint.toBase58(),
    });
    console.log(`Created market ${spec.id}: ${market.toBase58()}`);
    console.log(`Created pool ${spec.id}: ${pool.toBase58()}`);
  }

  const out = path.join(process.cwd(), 'sentinel-devnet-markets.json');
  fs.writeFileSync(out, JSON.stringify({
    network: 'devnet', program_id: PROGRAM_ID.toBase58(),
    creator_oracle_dispute_authority: payer.publicKey.toBase58(),
    collateral_mint: mint.toBase58(), user_token_account: userTokenAccount.toBase58(),
    markets: created,
  }, null, 2) + '\n');
  console.log(`Market manifest written to ${out}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
