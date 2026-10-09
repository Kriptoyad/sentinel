"use client";
import { useEffect, useState } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import { testUsdc } from "@/lib/format";
const mint = new PublicKey("6jnypkLny5TGDrJLw2vB7fTDu6iKRrZXmdmfKpd8JNC8");
const token = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const associated = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export function WalletControl() {
  const [mounted, setMounted] = useState(false);
  const {connection} = useConnection();
  const {publicKey} = useWallet();
  const [balance, setBalance] = useState<{owner:string; text:string} | null>(null);
  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    let active = true, pending = false, signing = false;
    setBalance(null);
    const refresh = async () => {
      if (!publicKey || pending || document.hidden || signing) return;
      pending = true;
      try {
        const ata = PublicKey.findProgramAddressSync([publicKey.toBuffer(), token.toBuffer(), mint.toBuffer()], associated)[0];
        const [walletAccount, account] = await connection.getMultipleAccountsInfo([publicKey, ata], "confirmed");
        if (account && (!account.owner.equals(token) || account.data.length < 72 ||
          !new PublicKey(account.data.subarray(0,32)).equals(mint) || !new PublicKey(account.data.subarray(32,64)).equals(publicKey))) throw new Error("Geçersiz test-USDC hesabı");
        const sol = walletAccount?.lamports ?? 0;
        const raw = account ? Buffer.from(account.data).readBigUInt64LE(64).toString() : "0";
        if (active) setBalance({owner:publicKey.toBase58(),text:`DEVNET · ${(sol/1e9).toFixed(4)} SOL · ${testUsdc(raw)}`});
      } catch (e) { if (active) setBalance({owner:publicKey.toBase58(),text:`Devnet bakiyesi okunamadı: ${e instanceof Error ? e.message : String(e)}`}); }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(()=>void refresh(),60000);
    const refreshEvent = ()=>void refresh();
    const transaction = (e: Event) => {
      const wasSigning = signing;
      signing = Boolean((e as CustomEvent<boolean>).detail);
      if (wasSigning && !signing) void refresh();
    };
    window.addEventListener("sentinel:transaction",transaction);
    window.addEventListener("sentinel:refresh-wallet",refreshEvent);
    return ()=>{active=false;clearInterval(timer);window.removeEventListener("sentinel:transaction",transaction);window.removeEventListener("sentinel:refresh-wallet",refreshEvent);};
  },[connection,publicKey]);
  return <div className="wallet-control">{mounted ? <WalletMultiButton /> : <button className="wallet-adapter-button" disabled>Cüzdan hazırlanıyor…</button>}
    {mounted && publicKey && <small className="wallet-balance" role="status">{balance?.owner === publicKey.toBase58() ? balance.text : "Devnet bakiyesi yükleniyor…"}</small>}
  </div>;
}
