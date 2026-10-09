"use client";
import { useState } from "react";
import Link from "next/link";
import type { Market } from "@/lib/types";
import { probability, dateTime } from "@/lib/format";
import { ProbabilityChart } from "./ProbabilityChart";
import { resolutionStage, stageLabel } from "@/lib/resolution";
import { marketTitle } from "@/lib/marketPresentation";
import { TradeDialog } from "./TradeDialog";

export function MarketCard({ market }: { market: Market }) {
  const [side, setSide] = useState<"Yes" | "No" | null>(null);
  const closed = market.resolved || market.resolution_deadline <= Date.now() / 1000;
  const verified = market.onchain_verified === true;
  const stage = resolutionStage(market);
  const title = marketTitle(market.question);
  const result = market.resolution_outcome == null ? "BELİRSİZ" : market.resolution_outcome ? "YES" : "NO";

  return <article className={`market-card ${market.market_type.toLowerCase()}`}>
    <div className="card-top">
      <span className="type-pill">{market.market_type === "Risk" ? "RISK MARKET" : "PRICE MARKET"}</span>
      <span className="market-id">MARKET #{market.market_id}</span>
    </div>
    <h2><Link href={`/markets/${market.market_id}`} title={market.question}>{title}</Link></h2>
    <div className="card-reading">
      <div><small>{market.resolved ? stage === "finalized" ? "KESİN SONUÇ" : "İTİRAZA AÇIK SONUÇ" : "MARKET PROBABILITY"}</small><strong className={market.resolved && result === "NO" ? "outcome-no" : undefined}>{market.resolved ? result : probability(market.probability_bps)}</strong></div>
      <span>{stageLabel[stage]}</span>
    </div>
    <div className="card-chart-slot">{market.resolved
      ? <div className="settlement-summary"><span>{stage === "finalized" ? "Çözüm kesinleşti" : "İtiraz penceresi açık"}</span><p>{stage === "finalized" ? "Uygun pozisyonlar ödeme panelinden kontrol edilebilir." : "Ödeme, itiraz penceresi kapandıktan sonra açılır."}</p></div>
      : <ProbabilityChart history={market.probability_history ?? []} compact />}</div>
    <div className="card-bottom">
      <span>DEADLINE · {dateTime(market.resolution_deadline)}</span>
      <Link href={`/markets/${market.market_id}`}>DETAYLAR ↗</Link>
    </div>
    {closed ? <div className="card-settled">
      <strong>{market.resolved
        ? stage === "finalized" ? "ÖDEME DURUMU" : "İTİRAZ SÜRECİ"
        : "ÇÖZÜM BEKLENİYOR"}</strong>
      <span>Yeni pozisyonlara kapalı</span>
      <button onClick={() => setSide(side ? null : "Yes")}>{side ? "Paneli kapat ×" : "POZİSYON / ÖDEME →"}</button>

    </div> : <>
      <div className="card-trade-buttons">
        <button onClick={() => setSide("Yes")} className="trade-yes">YES</button>
        <button onClick={() => setSide("No")} className="trade-no">NO</button>
      </div>
      <p className="card-trade-caption">{verified
        ? "DEVNET · 1 TEST-USDC · CÜZDAN İMZASI"
        : "DEVNET DOĞRULAMASI BEKLENİYOR"}</p>

    </>}
    {side && <TradeDialog market={market} verified={verified} side={side} onClose={()=>setSide(null)} />}
  </article>;
}
