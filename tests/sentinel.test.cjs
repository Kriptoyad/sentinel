const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Program, AnchorProvider, BN } = require('@anchor-lang/core');
const { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint, createAssociatedTokenAccount, getAssociatedTokenAddressSync,
  getAccount, mintTo,
} = require('@solana/spl-token');

test('stake returns to owner; an outsider cannot close or switch markets', async () => {
  const provider = AnchorProvider.env();
  const connection = provider.connection;
  assert.match(connection.rpcEndpoint, /127\.0\.0\.1|localhost/, 'Tests must use local validator');
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.ANCHOR_WALLET, 'utf8'))));
  const idl = JSON.parse(fs.readFileSync('target/idl/sentinel.json', 'utf8'));
  const program = new Program(idl, provider);
  const programId = new PublicKey(idl.address);
  assert.equal(programId.toBase58(), '3PA87yNfZD3DptejAafT2ovehCkh3xo8DhUVQoyWTw2P');

  if ((await connection.getBalance(payer.publicKey)) < LAMPORTS_PER_SOL) {
    const sig = await connection.requestAirdrop(payer.publicKey, 5 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, 'confirmed');
  }
  const outsider = Keypair.generate();
  const outsiderAirdrop = await connection.requestAirdrop(outsider.publicKey, LAMPORTS_PER_SOL);
  await connection.confirmTransaction(outsiderAirdrop, 'confirmed');
  const mint = await createMint(connection, payer, payer.publicKey, null, 6);
  const ownerToken = await createAssociatedTokenAccount(connection, payer, mint, payer.publicKey);
  const outsiderToken = await createAssociatedTokenAccount(connection, payer, mint, outsider.publicKey);
  await mintTo(connection, payer, mint, ownerToken, payer, 1_000_000n);

  const makeMarket = async (id, marketType = 'price', deadlineOffset = 3600) => {
    const idBytes = Buffer.alloc(8);
    idBytes.writeBigUInt64LE(id);
    const [market] = PublicKey.findProgramAddressSync([Buffer.from('market'), idBytes], programId);
    const [pool] = PublicKey.findProgramAddressSync([Buffer.from('pool'), market.toBuffer()], programId);
    const marketVault = getAssociatedTokenAddressSync(mint, market, true);
    const poolVault = getAssociatedTokenAddressSync(mint, pool, true);
    await program.methods.initializeMarket(
      new BN(id.toString()), { [marketType]: {} }, Array(32).fill(1),
      'https://example.invalid/local-test', 5000,
      payer.publicKey, payer.publicKey, new BN(Math.floor(Date.now() / 1000) + deadlineOffset),
    ).accountsStrict({
      creator: payer.publicKey, market, collateralMint: mint, marketVault,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).rpc();
    await program.methods.initPool(Array(32).fill(2)).accountsStrict({
      authority: payer.publicKey, market, pool, collateralMint: mint, poolVault,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).rpc();
    return { market, pool, marketVault };
  };

  const id = BigInt(Date.now());
  const first = await makeMarket(id);
  const other = await makeMarket(id + 1n);
  const [position] = PublicKey.findProgramAddressSync(
    [Buffer.from('position'), first.market.toBuffer(), payer.publicKey.toBuffer()], programId,
  );
  await program.methods.openPosition({ yes: {} }, new BN(200_000)).accountsStrict({
    user: payer.publicKey, market: first.market, pool: first.pool, position,
    userTokenAccount: ownerToken, marketVault: first.marketVault, collateralMint: mint,
    tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).rpc();
  assert.equal((await getAccount(connection, ownerToken)).amount, 800_000n);
  assert.equal((await getAccount(connection, first.marketVault)).amount, 200_000n);

  const close = (user, userTokenAccount, marketData, signers = []) =>
    program.methods.closePosition().accountsStrict({
      user, market: marketData.market, pool: marketData.pool, position,
      userTokenAccount, marketVault: marketData.marketVault,
      collateralMint: mint, tokenProgram: TOKEN_PROGRAM_ID,
    }).signers(signers).rpc();

  await assert.rejects(close(outsider.publicKey, outsiderToken, first, [outsider]));
  assert.equal((await getAccount(connection, first.marketVault)).amount, 200_000n);
  assert.equal((await program.account.position.fetch(position)).closed, false);

  await assert.rejects(close(payer.publicKey, ownerToken, other));
  assert.equal((await getAccount(connection, first.marketVault)).amount, 200_000n);

  await close(payer.publicKey, ownerToken, first);
  assert.equal((await getAccount(connection, ownerToken)).amount, 1_000_000n);
  assert.equal((await getAccount(connection, first.marketVault)).amount, 0n);
  assert.equal((await program.account.position.fetch(position)).closed, true);
  const marketState = await program.account.market.fetch(first.market);
  assert.equal(marketState.totalYesExposure.toString(), '0');
  await assert.rejects(close(payer.publicKey, ownerToken, first));

  // A risk pool cannot be funded with only one side. Once funded, each
  // outcome retains at least one claimable position until resolution.
  const risk = await makeMarket(id + 2n, 'risk', 30);
  const [ownerRiskPosition] = PublicKey.findProgramAddressSync(
    [Buffer.from('position'), risk.market.toBuffer(), payer.publicKey.toBuffer()], programId,
  );
  const [outsiderRiskPosition] = PublicKey.findProgramAddressSync(
    [Buffer.from('position'), risk.market.toBuffer(), outsider.publicKey.toBuffer()], programId,
  );
  const riskPool = PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), risk.market.toBuffer()], programId,
  )[0];
  const riskPoolVault = getAssociatedTokenAddressSync(mint, riskPool, true);
  const fundRisk = () => program.methods.fundPool(new BN(100_000)).accountsStrict({
    funder: payer.publicKey, market: risk.market, pool: risk.pool,
    funderTokenAccount: ownerToken, poolVault: riskPoolVault,
    collateralMint: mint, tokenProgram: TOKEN_PROGRAM_ID,
  }).rpc();
  await program.methods.openPosition({ yes: {} }, new BN(100_000)).accountsStrict({
    user: payer.publicKey, market: risk.market, pool: risk.pool, position: ownerRiskPosition,
    userTokenAccount: ownerToken, marketVault: risk.marketVault, collateralMint: mint,
    tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).rpc();
  await assert.rejects(fundRisk());
  assert.equal((await getAccount(connection, riskPoolVault)).amount, 0n);
  await mintTo(connection, payer, mint, outsiderToken, payer, 100_000n);
  await program.methods.openPosition({ no: {} }, new BN(100_000)).accountsStrict({
    user: outsider.publicKey, market: risk.market, pool: risk.pool, position: outsiderRiskPosition,
    userTokenAccount: outsiderToken, marketVault: risk.marketVault, collateralMint: mint,
    tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).signers([outsider]).rpc();
  await fundRisk();
  assert.equal((await getAccount(connection, riskPoolVault)).amount, 100_000n);
  await assert.rejects(program.methods.closePosition().accountsStrict({
    user: payer.publicKey, market: risk.market, pool: risk.pool, position: ownerRiskPosition,
    userTokenAccount: ownerToken, marketVault: risk.marketVault,
    collateralMint: mint, tokenProgram: TOKEN_PROGRAM_ID,
  }).rpc());
  assert.equal((await getAccount(connection, risk.marketVault)).amount, 200_000n);
  await assert.rejects(program.methods.resolveMarket(true).accountsStrict({
    oracleAuthority: payer.publicKey, market: risk.market,
  }).rpc());
  // Wait for the deadline, then check the proposed outcome can be disputed,
  // and that no claims or new deposits are allowed while it is pending.
  const deadline = Number((await program.account.market.fetch(risk.market)).resolutionDeadline.toString());
  const remaining = deadline - Math.floor(Date.now() / 1000);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, (remaining + 2) * 1000));
  await program.methods.resolveMarket(true).accountsStrict({
    oracleAuthority: payer.publicKey, market: risk.market,
  }).rpc();
  await assert.rejects(fundRisk());
  await assert.rejects(program.methods.claimPayout().accountsStrict({
    user: payer.publicKey, market: risk.market, pool: risk.pool,
    position: ownerRiskPosition, userTokenAccount: ownerToken,
    poolVault: riskPoolVault, marketVault: risk.marketVault,
    collateralMint: mint, tokenProgram: TOKEN_PROGRAM_ID,
  }).rpc());
  assert.equal((await getAccount(connection, risk.marketVault)).amount, 200_000n);
  await program.methods.overrideResolution(false).accountsStrict({
    disputeAuthority: payer.publicKey, market: risk.market,
  }).rpc();
  assert.equal((await program.account.market.fetch(risk.market)).resolutionOutcome, false);

  if (process.env.SENTINEL_FAST_TEST === '1') {
    const state = await program.account.market.fetch(risk.market);
    const finalAt = Number(state.finalizedAt.toString());
    const resolvedAt = Number(state.resolutionTs.toString());
    assert.equal(finalAt - resolvedAt, 3, 'Local-only short dispute build was not loaded');
    const secondsLeft = finalAt - Math.floor(Date.now() / 1000);
    if (secondsLeft >= 0) await new Promise(resolve => setTimeout(resolve, (secondsLeft + 2) * 1000));

    const winnerClaim = () => program.methods.claimPayout().accountsStrict({
      user: outsider.publicKey, market: risk.market, pool: risk.pool,
      position: outsiderRiskPosition, userTokenAccount: outsiderToken,
      poolVault: riskPoolVault, marketVault: risk.marketVault,
      collateralMint: mint, tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([outsider]).rpc();
    await assert.rejects(program.methods.claimPayout().accountsStrict({
      user: payer.publicKey, market: risk.market, pool: risk.pool,
      position: ownerRiskPosition, userTokenAccount: ownerToken,
      poolVault: riskPoolVault, marketVault: risk.marketVault,
      collateralMint: mint, tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc());
    await winnerClaim();
    assert.equal((await getAccount(connection, outsiderToken)).amount, 300_000n);
    assert.equal((await getAccount(connection, risk.marketVault)).amount, 0n);
    assert.equal((await getAccount(connection, riskPoolVault)).amount, 0n);
    assert.equal((await program.account.pool.fetch(risk.pool)).totalClaimed.toString(), '100000');
    await assert.rejects(winnerClaim());

    // A price market with no winning side returns the remaining stakes.
    const refund = await makeMarket(id + 3n, 'price', 8);
    const [refundPosition] = PublicKey.findProgramAddressSync(
      [Buffer.from('position'), refund.market.toBuffer(), payer.publicKey.toBuffer()], programId,
    );
    await program.methods.openPosition({ yes: {} }, new BN(50_000)).accountsStrict({
      user: payer.publicKey, market: refund.market, pool: refund.pool, position: refundPosition,
      userTokenAccount: ownerToken, marketVault: refund.marketVault, collateralMint: mint,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).rpc();
    const refundDeadline = Number((await program.account.market.fetch(refund.market)).resolutionDeadline.toString());
    const untilDeadline = refundDeadline - Math.floor(Date.now() / 1000);
    if (untilDeadline >= 0) await new Promise(resolve => setTimeout(resolve, (untilDeadline + 2) * 1000));
    await program.methods.resolveMarket(false).accountsStrict({
      oracleAuthority: payer.publicKey, market: refund.market,
    }).rpc();
    const refundFinal = Number((await program.account.market.fetch(refund.market)).finalizedAt.toString());
    const untilFinal = refundFinal - Math.floor(Date.now() / 1000);
    if (untilFinal >= 0) await new Promise(resolve => setTimeout(resolve, (untilFinal + 2) * 1000));
    await program.methods.claimPayout().accountsStrict({
      user: payer.publicKey, market: refund.market, pool: refund.pool,
      position: refundPosition, userTokenAccount: ownerToken,
      poolVault: getAssociatedTokenAddressSync(mint, refund.pool, true),
      marketVault: refund.marketVault, collateralMint: mint, tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc();
    assert.equal((await getAccount(connection, refund.marketVault)).amount, 0n);
    assert.equal((await program.account.position.fetch(refundPosition)).closed, true);
  }
});
