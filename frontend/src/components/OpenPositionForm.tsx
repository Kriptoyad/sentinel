"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Buffer } from "buffer";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction, SendTransactionError, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import idl from "@/idl/sentinel.json";
import { PROGRAM_ID, deriveMarketAddress } from "@/lib/solana";
import { decodeMarket } from "@/lib/marketAccount";
import { testUsdc } from "@/lib/format";
import type { Market } from "@/lib/types";

const MINT = new PublicKey("6jnypkLny5TGDrJLw2vB7fTDu6iKRrZXmdmfKpd8JNC8");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const WARNING = "This is not insurance. Any payout is limited to funds actually deposited in the voluntary pool.";
const ata = (owner: PublicKey) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), MINT.toBuffer()], ATA)[0];

async function rpcRead<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("RPC 15 saniyede yanıt vermedi. İşlem gönderilmedi.")), 15000);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export function OpenPositionForm({ market, verified, initialSide = "Yes" }: { market: Market; verified: boolean; initialSide?: "Yes" | "No" }) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const router = useRouter();
  const [side, setSide] = useState<"Yes" | "No">(initialSide);
  const [sol, setSol] = useState("—");
  const [tokens, setTokens] = useState(0n);
  const [loaded, setLoaded] = useState(false);
  const [loadedWallet, setLoadedWallet] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Devnet cüzdanını bağla.");
  const [signature, setSignature] = useState("");
  const [positionState, setPositionState] = useState<{ side: "Yes" | "No"; size: bigint; closed: boolean } | null>(null);
  const [currentMarket, setCurrentMarket] = useState(market);
  const [chainTime, setChainTime] = useState(0);
  const [poolDeposit, setPoolDeposit] = useState(0n);
  const generation = useRef(0);
  const refreshPending = useRef<number | null>(null);
  const signing = useRef(false);
  const retryAfter = useRef(60000);
  const walletAddress = publicKey?.toBase58();
  const addresses = useCallback((owner: PublicKey) => {
    const marketKey = deriveMarketAddress(market.market_id);
    const pool = PublicKey.findProgramAddressSync([Buffer.from("pool"), marketKey.toBuffer()], PROGRAM_ID)[0];
    const position = PublicKey.findProgramAddressSync([Buffer.from("position"), marketKey.toBuffer(), owner.toBuffer()], PROGRAM_ID)[0];
    return { marketKey, pool, position };
  }, [market.market_id]);


  const refresh = useCallback(async (force = false) => {
    if (refreshPending.current === generation.current || (!force && (document.hidden || signing.current))) return;
    if (!publicKey) {
      setLoaded(false); setTokens(0n); setSol("—"); return;
    }
    const version = generation.current;
    refreshPending.current = version;
    try {
      const { marketKey, pool, position } = addresses(publicKey);
      const [ma, po, pos, clock, walletAccount, account] = await rpcRead(connection.getMultipleAccountsInfo(
        [marketKey, pool, position, SYSVAR_CLOCK_PUBKEY, publicKey, ata(publicKey)], "confirmed"));
      if (account && (!account.owner.equals(TOKEN) || account.data.length < 72 ||
        !new PublicKey(account.data.subarray(0,32)).equals(MINT) || !new PublicKey(account.data.subarray(32,64)).equals(publicKey))) throw new Error("Test-USDC token hesabı geçersiz.");
      const balance = account ? account.data.readBigUInt64LE(64) : 0n;
      const lamports = walletAccount?.lamports ?? 0;
      if (!ma?.owner.equals(PROGRAM_ID) || !po?.owner.equals(PROGRAM_ID)) throw new Error("Market/pool okunamadı.");
      const chain = decodeMarket(ma.data);
      const poolDisc = idl.accounts.find(a => a.name.toLowerCase() === "pool")!.discriminator;
      if (po.data.length < 121 || !po.data.subarray(0,8).equals(Buffer.from(poolDisc)) || !new PublicKey(po.data.subarray(8,40)).equals(marketKey)) throw new Error("Pool geçersiz.");
      let decodedPosition = null;
      if (pos) {
        const disc = idl.accounts.find(a => a.name.toLowerCase() === "position")!.discriminator;
        if (!pos.owner.equals(PROGRAM_ID) || pos.data.length < 101 || !pos.data.subarray(0,8).equals(Buffer.from(disc)) ||
            !new PublicKey(pos.data.subarray(8,40)).equals(marketKey) || !new PublicKey(pos.data.subarray(40,72)).equals(publicKey) || pos.data[72] > 1 || pos.data[99] > 1) throw new Error("Pozisyon hesabı geçersiz.");
        decodedPosition = {side: pos.data[72] === 0 ? "Yes" as const : "No" as const, size: pos.data.readBigUInt64LE(73), closed: pos.data[99] === 1};
      }
      if (!clock || clock.data.length < 40) throw new Error("Zincir saati okunamadı.");
      if (version !== generation.current) return;
      setCurrentMarket({...market, ...chain});
      setChainTime(Number(clock.data.readBigInt64LE(32)));
      setPoolDeposit(po.data.readBigUInt64LE(72));
      setPositionState(decodedPosition);
      setSol((lamports / 1e9).toFixed(5));
      setTokens(balance);
      setLoadedWallet(publicKey.toBase58());
      setLoaded(true);
      retryAfter.current = 60000;
      setStatus(previous => previous === "Devnet hesapları yükleniyor…" || previous.startsWith("Hesaplar okunamadı:")
        ? "Devnet hesapları güncel." : previous);
    } catch (e) {
      if (version !== generation.current) return;
      setLoaded(false);
      retryAfter.current = 180000;
      setStatus(`Hesaplar okunamadı: ${e instanceof Error ? e.message : String(e)}`);
    } finally { if (refreshPending.current === version) refreshPending.current = null; }
  }, [connection, publicKey, addresses, market.market_id]);

  useEffect(() => {
    generation.current++;
    setLoaded(false); setPositionState(null); setSignature("");
    setStatus(publicKey ? "Devnet hesapları yükleniyor…" : "Devnet cüzdanını bağla.");
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      await refresh();
      if (active) timer = setTimeout(tick, retryAfter.current);
    }
    timer = setTimeout(tick, 0);
    return () => { active = false; generation.current++; clearTimeout(timer); };
  }, [refresh]);

  async function open() {
    if (!publicKey || !verified || !loaded || busy || loadedWallet !== publicKey.toBase58()) return;
    signing.current = true;
    setBusy(true);
    window.dispatchEvent(new CustomEvent("sentinel:transaction", {detail: true}));
    setSignature("");
    setStatus("Devnet hesapları kontrol ediliyor…");
    try {
      if (market.resolved || market.resolution_deadline <= Date.now() / 1000)
        throw new Error("Pazar kapalı veya deadline geçti.");
      if (idl.address !== PROGRAM_ID.toBase58() || market.collateral_mint !== MINT.toBase58())
        throw new Error("Program ID veya collateral mint uyuşmuyor.");

      const marketKey = deriveMarketAddress(market.market_id);
      const pool = PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), marketKey.toBuffer()], PROGRAM_ID
      )[0];
      const position = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), marketKey.toBuffer(), publicKey.toBuffer()], PROGRAM_ID
      )[0];
      const user = ata(publicKey), vault = ata(marketKey);
      const [ma, po, pos, ua, va, mint] = await connection.getMultipleAccountsInfo(
        [marketKey, pool, position, user, vault, MINT], "confirmed"
      );

      if (!ma?.owner.equals(PROGRAM_ID) || !po?.owner.equals(PROGRAM_ID))
        throw new Error("Market veya pool hesabı doğru programda bulunamadı.");
      if (pos)
        throw new Error("Bu cüzdanın bu pazarda zaten pozisyon hesabı var.");
      if (!ua?.owner.equals(TOKEN) || !va?.owner.equals(TOKEN) ||
          !mint?.owner.equals(TOKEN) || mint.data[44] !== 6)
        throw new Error("Devnet test-USDC hesabı, vault veya mint geçersiz/eksik.");

      const discriminator = idl.accounts.find(a => a.name.toLowerCase() === "pool")?.discriminator;
      if (!discriminator || !po.data.subarray(0, 8).equals(Buffer.from(discriminator)) ||
          po.data.length < 120 || !new PublicKey(po.data.subarray(8, 40)).equals(marketKey))
        throw new Error("Pool yapısı güncel IDL ile uyuşmuyor.");

      const hash = Buffer.from(await crypto.subtle.digest(
        "SHA-256", new TextEncoder().encode(WARNING)
      ));
      if (!po.data.subarray(88, 120).equals(hash))
        throw new Error("Pool disclaimer hash, gösterilen uyarı metniyle uyuşmuyor. İşlem gönderilmedi.");

      const balance = await connection.getTokenAccountBalance(user, "confirmed");
      if (BigInt(balance.value.amount) < 1000000n)
        throw new Error("En az 1 test-USDC gerekiyor.");

      const ix = idl.instructions.find(i => i.name === "open_position");
      if (!ix || ix.accounts.map(a => a.name).join(",") !==
          "user,market,pool,position,user_token_account,market_vault,collateral_mint,token_program,system_program")
        throw new Error("open_position hesap sırası IDL ile uyuşmuyor.");

      const freshMarket = decodeMarket(ma.data);
      const clock = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed");
      if (!clock || freshMarket.resolved || Number(clock.data.readBigInt64LE(32)) >= freshMarket.resolution_deadline) throw new Error("Pazar yeni pozisyonlara kapalı.");
      if (!new PublicKey(ua.data.subarray(0,32)).equals(MINT) || !new PublicKey(ua.data.subarray(32,64)).equals(publicKey) ||
          !new PublicKey(va.data.subarray(0,32)).equals(MINT) || !new PublicKey(va.data.subarray(32,64)).equals(marketKey)) throw new Error("Token hesabının mint/authority bilgisi geçersiz.");
      const data = Buffer.alloc(17);
      Buffer.from(ix.discriminator).copy(data);
      data[8] = side === "Yes" ? 0 : 1;
      data.writeBigUInt64LE(1000000n, 9);
      const keys = [
        publicKey, marketKey, pool, position, user, vault, MINT, TOKEN, SystemProgram.programId
      ].map((pubkey, index) => ({
        pubkey, isSigner: index === 0, isWritable: [0, 1, 3, 4, 5].includes(index)
      }));
      const latest = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction({ feePayer: publicKey, ...latest }).add(
        new TransactionInstruction({ programId: PROGRAM_ID, keys, data })
      );

      setStatus("Phantom imzası bekleniyor…");
      const sig = await sendTransaction(tx, connection, { preflightCommitment: "confirmed" });
      setSignature(sig);
      setStatus("Devnet onayı bekleniyor…");
      const result = await connection.confirmTransaction(
        { signature: sig, ...latest }, "confirmed"
      );
      if (result.value.err) throw new Error(JSON.stringify(result.value.err));

      setStatus("Pozisyon Devnet'te onaylandı. 1 test-USDC yatırıldı.");
      await refresh(true);
      window.dispatchEvent(new Event("sentinel:refresh-wallet"));
      router.refresh();
    } catch (e) {
      let message = e instanceof Error ? e.message : String(e);
      if (e instanceof SendTransactionError) {
        try { message += "\n" + (await e.getLogs(connection))?.join("\n"); } catch {}
      }
      setStatus(message);
    } finally {
      signing.current = false;
      setBusy(false);
      window.dispatchEvent(new CustomEvent("sentinel:transaction", {detail: false}));
    }
  }

  async function settle(action: "close_position" | "claim_payout") {
    if (!publicKey || !verified || !loaded || busy || loadedWallet !== publicKey.toBase58()) return;
    signing.current = true;
    setBusy(true); setSignature("");
    window.dispatchEvent(new CustomEvent("sentinel:transaction", {detail: true}));
    try {
      const {marketKey, pool, position} = addresses(publicKey);
      const ix = idl.instructions.find(i => i.name === action);
      if (!ix || idl.address !== PROGRAM_ID.toBase58()) throw new Error("Güncel instruction/IDL bulunamadı.");
      const accounts: Record<string, PublicKey> = {user: publicKey, market: marketKey, pool, position,
        user_token_account: ata(publicKey), pool_vault: ata(pool), market_vault: ata(marketKey),
        collateral_mint: MINT, token_program: TOKEN};
      const expected = action === "claim_payout"
        ? "user,market,pool,position,user_token_account,pool_vault,market_vault,collateral_mint,token_program"
        : "user,market,pool,position,user_token_account,market_vault,collateral_mint,token_program";
      if (ix.accounts.map(a=>a.name).join(",") !== expected) throw new Error("Instruction hesap sırası uyuşmuyor.");
      const latest = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction({feePayer: publicKey, ...latest}).add(new TransactionInstruction({
        programId: PROGRAM_ID, data: Buffer.from(ix.discriminator),
        keys: ix.accounts.map(a=>({pubkey: accounts[a.name], isSigner: "signer" in a && a.signer === true, isWritable: "writable" in a && a.writable === true}))
      }));
      setStatus("Cüzdan imzası bekleniyor…");
      const sig = await sendTransaction(tx, connection, {preflightCommitment: "confirmed"});
      setSignature(sig); setStatus("Devnet onayı bekleniyor…");
      const result = await connection.confirmTransaction({signature: sig, ...latest}, "confirmed");
      if (result.value.err) throw new Error(JSON.stringify(result.value.err));
      setStatus(action === "claim_payout" ? "Ödeme Devnet'te onaylandı. Bakiyeler yenilendi." : "Pozisyon kapatıldı; anapara iade edildi.");
      await refresh(true); window.dispatchEvent(new Event("sentinel:refresh-wallet")); router.refresh();
    } catch (e) {
      let message = e instanceof Error ? e.message : String(e);
      if (e instanceof SendTransactionError) { try { message += "\n" + (await e.getLogs(connection))?.join("\n"); } catch {} }
      setStatus(message);
    } finally { signing.current = false; setBusy(false); window.dispatchEvent(new CustomEvent("sentinel:transaction", {detail: false})); }
  }

  const closed = currentMarket.resolved || (chainTime || Date.now()/1000) >= currentMarket.resolution_deadline;
  const finalized = currentMarket.resolved && currentMarket.finalized_at != null && chainTime >= currentMarket.finalized_at;
  const winningExposure = BigInt(currentMarket.resolution_outcome ? currentMarket.total_yes_exposure : currentMarket.total_no_exposure);
  const won = positionState && (positionState.side === "Yes") === currentMarket.resolution_outcome;
  const claimable = finalized && positionState && !positionState.closed && (won || winningExposure === 0n);
  const sideExposure = positionState ? BigInt(positionState.side === "Yes" ? currentMarket.total_yes_exposure : currentMarket.total_no_exposure) : 0n;
  const lastFunded = positionState && poolDeposit > 0n && sideExposure <= positionState.size;
  const estimate = claimable && positionState ? winningExposure === 0n ? positionState.size :
    (BigInt(currentMarket.total_yes_exposure) + BigInt(currentMarket.total_no_exposure)) * positionState.size / winningExposure + poolDeposit * positionState.size / winningExposure : null;
  return <section className="detail-panel position-panel" style={{marginTop:24}}>
    <h2>Pozisyon & ödeme</h2>
    <p>Cüzdan: <code>{walletAddress ?? "Bağlı değil"}</code></p>
    <p>SOL: {sol} · {publicKey && loadedWallet === walletAddress ? testUsdc(tokens) : "test-USDC: —"}</p>
    {!loaded && loadedWallet === walletAddress && publicKey && <p>Son başarılı okuma gösteriliyor; güncel hesaplar doğrulanana kadar işlemler kapalı.</p>}
    <p className="data-caption">{WARNING}</p>
    {loaded && <p>Gönüllü bonus havuzu: {testUsdc(poolDeposit)} · Anapara paylaşımından ayrı.</p>}
    {positionState ? <>
      <div className="position-summary"><strong>{positionState.side.toUpperCase()} · {testUsdc(positionState.size)}</strong><span>{positionState.closed ? "KAPALI" : "POZİSYON MEVCUT"}</span></div>
      {!positionState.closed && !closed && <button disabled={busy || !verified || !loaded || !!lastFunded} onClick={()=>settle("close_position")}>POZİSYONU KAPAT · ANAPARAYI AL</button>}
      {!positionState.closed && !closed && lastFunded && <p>Fonlanmış havuzda bu tarafın son pozisyonu çözümden önce kapatılamaz.</p>}
      {claimable && <><p>Hesaplanan ödeme: {testUsdc(estimate!)}. Kesin tutar zincirde belirlenir.</p><button disabled={busy || !verified || !loaded} onClick={()=>settle("claim_payout")}>ÖDEMEYİ AL · CLAIM</button></>}
      {!positionState.closed && currentMarket.resolved && !finalized && <p>İtiraz penceresi açık. Ödeme zamanı: {currentMarket.finalized_at ? new Date(currentMarket.finalized_at*1000).toLocaleString() : "bekleniyor"}.</p>}
      {!positionState.closed && finalized && !claimable && <p>Bu pozisyon kaybeden tarafta; ödeme hakkı yok.</p>}
      {positionState.closed && <p>Bu cüzdan bu pazarda yeniden pozisyon açamaz; sözleşme tek pozisyon hesabı kullanır.</p>}
    </> : <>
      {!closed && <><label>Taraf: <select value={side} onChange={e=>setSide(e.target.value as "Yes"|"No")} disabled={busy}><option value="Yes">YES</option><option value="No">NO</option></select></label>{" "}<button onClick={open} disabled={!publicKey || !verified || !loaded || tokens < 1000000n || busy}>{busy ? "İŞLEM BEKLENİYOR…" : "1 TEST-USDC İLE POZİSYON AÇ"}</button></>}
      {closed && <p>Yeni pozisyonlara kapalı. Bağlı cüzdana ait pozisyon bulunamadı.</p>}
      {publicKey && loaded && !closed && tokens < 1000000n && <p>En az 1 test-USDC gerekiyor.</p>}
    </>}
    {!verified && <p>Devnet hesabı doğrulanamadığı için işlem kapalı.</p>}
    <pre role="status" aria-live="polite" style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{status}</pre>
    {signature && <a href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`} target="_blank" rel="noopener noreferrer">İşlem imzası: {signature}</a>}
  </section>;
}
