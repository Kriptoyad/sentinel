"use client";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { OpenPositionForm } from "./OpenPositionForm";
import { marketTitle } from "@/lib/marketPresentation";
import type { Market } from "@/lib/types";

export function TradeDialog({ market, verified, side, onClose }: {
  market: Market; verified: boolean; side: "Yes" | "No"; onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  const titleId = useId();
  const { publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    if (!mounted) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    function keyboard(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); close.current(); }
      if (e.key !== "Tab") return;
      const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),[tabindex="0"]'
      ) ?? []).filter(node => node.getClientRects().length > 0);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (!first) { e.preventDefault(); return; }
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", keyboard);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", keyboard);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [mounted]);
  if (!mounted) return null;
  return createPortal(<div style={{position:"fixed",inset:0,zIndex:2147483000,display:"flex",alignItems:"center",justifyContent:"center",padding:16,background:"rgba(2,9,8,.86)",backdropFilter:"blur(6px)"}}
    onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section ref={panel} className="trade-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="trade-dialog-heading"><div><p className="eyebrow">DEVNET · MARKET #{market.market_id}</p><h2 id={titleId}>Pozisyon & ödeme</h2></div>
        <button ref={closeButton} type="button" className="dialog-close" aria-label="Pencereyi kapat" onClick={onClose}>×</button>
      </div>
      <p className="trade-dialog-question">{marketTitle(market.question)}</p>
      {!publicKey && <div className="dialog-connect"><p>Devnet cüzdanını bağla.</p><button onClick={() => { onClose(); setVisible(true); }}>CÜZDAN BAĞLA</button><small>Bağlandıktan sonra işlem panelini yeniden aç.</small></div>}
      <OpenPositionForm market={market} verified={verified} initialSide={side} />
    </section>
  </div>, document.body);
}
