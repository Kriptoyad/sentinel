const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Program, AnchorProvider, BN } = require('@anchor-lang/core');
const {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
  getMint,
  createAssociatedTokenAccount,
  transfer,
} = require('@solana/spl-token');

const PROGRAM_ID = new PublicKey('3PA87yNfZD3DptejAafT2ovehCkh3xo8DhUVQoyWTw2P');
const COLLATERAL_MINT = new PublicKey('6jnypkLny5TGDrJLw2vB7fTDu6iKRrZXmdmfKpd8JNC8');
const TOKEN_DECIMALS = 6;
const DEADLINE_OFFSET_SECONDS = 90 * 60;
const TEST_USER_SOL = 0.05;
const TEST_POSITION_USDC = { yes: 50, no: 30 };
const POOL_FUNDING_USDC = 20;
const DISPUTE_NOTICE = 'This is not insurance. Any payout is limited to funds actually deposited in the voluntary pool.';

const SPECS = [
  {
    id: 3n,
    type: { price: {} },
    label: 'Price',
    question: 'SOL, deadline anında $250\'ın üzerinde mi olacak?',
    resolutionRules: 'At the exact UTC deadline, the oracle authority attests whether its designated SOL/USD reading is above $250. The program does not verify a Pyth price update.',
    initialProbability: 5000,
  },
  {
    id: 4n,
    type: { risk: {} },
    label: 'Risk',
    question: 'Demo Protokolü, deadline\'a kadar doğrulanmış bir exploit\'e uğrayacak mı?',
    resolutionRules: 'At the exact UTC deadline, the oracle authority attests whether a publicly documented Demo Protocol exploit was confirmed by then. This is an illustrative market, not a real protocol assessment or insurance.',
    initialProbability: 5000,
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

function derivePosition(market, owner) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('position'), market.toBuffer(), owner.toBuffer()],
    PROGRAM_ID,
  )[0];
}

function metadataUri(questionHash) {
  const body = JSON.stringify({ qh: questionHash.toString('hex'), m: 'deadline_snapshot' });
  const uri = `data:application/json;base64,${Buffer.from(body).toString('base64')}`;
  if (Buffer.byteLength(uri, 'utf8') > 200) throw new Error('Metadata URI exceeds the contract limit');
  return uri;
}

function readOrCreateKeypair(filename) {
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.existsSync(filename)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(filename, 'utf8'))));
  }
  const keypair = Keypair.generate();
  fs.writeFileSync(filename, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600, flag: 'wx' });
  return keypair;
}

async function ensureAta(connection, payer, mint, owner) {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  try {
    await getAccount(connection, ata, 'confirmed');
  } catch {
    await createAssociatedTokenAccount(connection, payer, mint, owner);
  }
  return ata;
}

async function ensureDevnetSol(connection, payer, recipient) {
  const targetLamports = Math.round(TEST_USER_SOL * LAMPORTS_PER_SOL);
  let balance = await connection.getBalance(recipient.publicKey, 'confirmed');
  if (balance >= targetLamports) return;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const latest = await connection.getLatestBlockhash('confirmed');
    const transaction = new Transaction({
      feePayer: payer.publicKey,
      recentBlockhash: latest.blockhash,
    }).add(SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient.publicKey,
      lamports: targetLamports - balance,
    }));
    transaction.sign(payer);

    try {
      const signature = await connection.sendRawTransaction(transaction.serialize(), {
        maxRetries: 3,
        preflightCommitment: 'confirmed',
      });
      await connection.confirmTransaction({ ...latest, signature }, 'confirmed');
      console.log(`Funded ${recipient.publicKey.toBase58()} with Devnet SOL (attempt ${attempt})`);
      return;
    } catch (error) {
      balance = await connection.getBalance(recipient.publicKey, 'confirmed');
      if (balance >= targetLamports) return;
      if (!/blockhash not found/i.test(String(error))) throw error;
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
    }
  }
}

async function ensureTestTokenBalance(connection, payer, sourceAta, destinationAta, targetAmount) {
  const target = BigInt(targetAmount);
  const destination = await getAccount(connection, destinationAta, 'confirmed');
  if (destination.amount >= target) return;
  const missing = target - destination.amount;
  await transfer(connection, payer, sourceAta, destinationAta, payer, missing);
  console.log(`Transferred ${Number(missing) / 10 ** TOKEN_DECIMALS} test-USDC`);
}

async function main() {
  process.env.ANCHOR_PROVIDER_URL ||= 'https://api.devnet.solana.com';
  process.env.ANCHOR_WALLET ||= path.join(process.env.HOME, '.config/solana/id.json');
  const provider = AnchorProvider.env();
  if (!/devnet/i.test(provider.connection.rpcEndpoint)) throw new Error('Refusing to run: provider must use Devnet');

  const runStartedAt = Math.floor(Date.now() / 1000);
  const deadline = runStartedAt + DEADLINE_OFFSET_SECONDS;
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(process.env.ANCHOR_WALLET, 'utf8'))),
  );
  const idlPath = path.join(process.cwd(), 'target/idl/sentinel.json');
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
  if (idl.address !== PROGRAM_ID.toBase58()) throw new Error('IDL address does not match the Sentinel program');
  const program = new Program(idl, provider);
  const { connection } = provider;
  const existingBalance = await connection.getBalance(payer.publicKey, 'confirmed');
  if (existingBalance < 200_000_000) {
    throw new Error(`Need at least 0.2 Devnet SOL in the authority wallet; found ${(existingBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  }

  const mintInfo = await getMint(connection, COLLATERAL_MINT, 'confirmed');
  if (mintInfo.decimals !== TOKEN_DECIMALS) throw new Error(`Collateral mint must have ${TOKEN_DECIMALS} decimals`);
  const markets = SPECS.map((spec) => ({ ...spec, market: deriveMarket(spec.id) }));
  for (const spec of markets) {
    const existing = await connection.getAccountInfo(spec.market, 'confirmed');
    if (existing) throw new Error(`Market ${spec.id} already exists at ${spec.market.toBase58()}; stopping to avoid duplicate setup`);
  }

  const walletDir = path.join(process.cwd(), 'target/demo-market-wallets');
  const yesWallet = readOrCreateKeypair(path.join(walletDir, 'market-4-yes.json'));
  const noWallet = readOrCreateKeypair(path.join(walletDir, 'market-4-no.json'));
  const sourceAta = getAssociatedTokenAddressSync(COLLATERAL_MINT, payer.publicKey);
  const sourceTokenAccount = await getAccount(connection, sourceAta, 'confirmed');
  const totalTestTokens = BigInt((TEST_POSITION_USDC.yes + TEST_POSITION_USDC.no + POOL_FUNDING_USDC) * 10 ** TOKEN_DECIMALS);
  if (sourceTokenAccount.amount < totalTestTokens) throw new Error('Authority wallet does not have enough demo collateral for positions and pool funding');

  console.log(`Devnet authority: ${payer.publicKey.toBase58()}`);
  console.log(`Market IDs: 3 and 4; common deadline: ${deadline} (${new Date(deadline * 1000).toISOString()})`);
  console.log(`Market 4 Yes wallet: ${yesWallet.publicKey.toBase58()}`);
  console.log(`Market 4 No wallet:  ${noWallet.publicKey.toBase58()}`);

  for (const wallet of [yesWallet, noWallet]) {
    await ensureDevnetSol(connection, payer, wallet);
  }

  const yesAta = await ensureAta(connection, payer, COLLATERAL_MINT, yesWallet.publicKey);
  const noAta = await ensureAta(connection, payer, COLLATERAL_MINT, noWallet.publicKey);
  await ensureTestTokenBalance(
    connection, payer, sourceAta, yesAta,
    BigInt(TEST_POSITION_USDC.yes * 10 ** TOKEN_DECIMALS),
  );
  await ensureTestTokenBalance(
    connection, payer, sourceAta, noAta,
    BigInt(TEST_POSITION_USDC.no * 10 ** TOKEN_DECIMALS),
  );

  const created = [];
  for (const spec of markets) {
    const pool = derivePool(spec.market);
    const marketVault = getAssociatedTokenAddressSync(COLLATERAL_MINT, spec.market, true);
    const poolVault = getAssociatedTokenAddressSync(COLLATERAL_MINT, pool, true);
    const questionHash = crypto.createHash('sha256').update(spec.question, 'utf8').digest();

    await program.methods.initializeMarket(
      new BN(spec.id.toString()),
      spec.type,
      Array.from(questionHash),
      metadataUri(questionHash),
      spec.initialProbability,
      payer.publicKey,
      payer.publicKey,
      new BN(deadline.toString()),
    ).accountsStrict({
      creator: payer.publicKey,
      market: spec.market,
      collateralMint: COLLATERAL_MINT,
      marketVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).rpc();

    const disclaimerHash = crypto.createHash('sha256').update(DISPUTE_NOTICE, 'utf8').digest();
    await program.methods.initPool(Array.from(disclaimerHash)).accountsStrict({
      authority: payer.publicKey,
      market: spec.market,
      pool,
      collateralMint: COLLATERAL_MINT,
      poolVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).rpc();

    created.push({
      market_id: spec.id.toString(),
      market_type: spec.label,
      question: spec.question,
      resolution_rules: spec.resolutionRules,
      probability_bps: String(spec.initialProbability),
      probability_history: [],
      total_yes_exposure: '0',
      total_no_exposure: '0',
      resolved: false,
      resolution_methodology: 'deadline_snapshot',
      resolution_deadline: deadline,
      oracle_authority: payer.publicKey.toBase58(),
      dispute_authority: payer.publicKey.toBase58(),
      market_address: spec.market.toBase58(),
      pool_address: pool.toBase58(),
      market_vault: marketVault.toBase58(),
      pool_vault: poolVault.toBase58(),
      collateral_mint: COLLATERAL_MINT.toBase58(),
    });
    console.log(`Created Market ${spec.id} (${spec.label}): ${spec.market.toBase58()}`);
    console.log(`Created Pool ${spec.id}: ${pool.toBase58()}`);
  }

  const risk = markets.find((market) => market.id === 4n);
  const riskPool = derivePool(risk.market);
  const riskMarketVault = getAssociatedTokenAddressSync(COLLATERAL_MINT, risk.market, true);
  const riskPoolVault = getAssociatedTokenAddressSync(COLLATERAL_MINT, riskPool, true);

  for (const [side, wallet, userAta, amount] of [
    ['yes', yesWallet, yesAta, TEST_POSITION_USDC.yes],
    ['no', noWallet, noAta, TEST_POSITION_USDC.no],
  ]) {
    const position = derivePosition(risk.market, wallet.publicKey);
    await program.methods.openPosition(
      { [side]: {} },
      new BN((amount * 10 ** TOKEN_DECIMALS).toString()),
    ).accountsStrict({
      user: wallet.publicKey,
      market: risk.market,
      pool: riskPool,
      position,
      userTokenAccount: userAta,
      marketVault: riskMarketVault,
      collateralMint: COLLATERAL_MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).signers([wallet]).rpc();
    console.log(`Opened Market 4 ${side.toUpperCase()} position: ${amount} test-USDC, ${position.toBase58()}`);
  }

  await program.methods.fundPool(new BN((POOL_FUNDING_USDC * 10 ** TOKEN_DECIMALS).toString())).accountsStrict({
    funder: payer.publicKey,
    market: risk.market,
    pool: riskPool,
    funderTokenAccount: sourceAta,
    poolVault: riskPoolVault,
    collateralMint: COLLATERAL_MINT,
    tokenProgram: TOKEN_PROGRAM_ID,
  }).rpc();
  console.log(`Funded Market 4 pool: ${POOL_FUNDING_USDC} test-USDC`);

  const manifestPath = path.join(process.cwd(), 'sentinel-devnet-markets.json');
  const existingManifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : { network: 'devnet', program_id: PROGRAM_ID.toBase58(), markets: [] };
  const oldMarkets = (existingManifest.markets || []).filter((item) => !['3', '4'].includes(String(item.market_id)));
  existingManifest.network = 'devnet';
  existingManifest.program_id = PROGRAM_ID.toBase58();
  existingManifest.creator_oracle_dispute_authority = payer.publicKey.toBase58();
  existingManifest.collateral_mint = COLLATERAL_MINT.toBase58();
  existingManifest.market_4_test_wallets = {
    yes: yesWallet.publicKey.toBase58(),
    no: noWallet.publicKey.toBase58(),
  };
  existingManifest.market_4_test_positions = { yes_amount: '50', no_amount: '30' };
  existingManifest.market_4_pool_funding = '20';
  existingManifest.markets = [...oldMarkets, ...created];
  fs.writeFileSync(manifestPath, JSON.stringify(existingManifest, null, 2) + '\n');

  console.log(`Manifest updated: ${manifestPath}`);
  console.log(`Short-market deadline Unix: ${deadline}`);
  console.log(`Short-market deadline Istanbul: ${new Date(deadline * 1000).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', hour12: false })}`);
  console.log('Wallet secret keys were saved under target/demo-market-wallets (do not share or commit them).');
}

main().catch((error) => {
  console.error(error?.logs?.join('\n') || error);
  process.exitCode = 1;
});
