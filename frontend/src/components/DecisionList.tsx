"use client";
import { useState } from "react";
import type { AgentDecision } from "@/lib/types";
import { probability, dateTime } from "@/lib/format";

type Decision = AgentDecision & { market?: { market_id: string } };
const agents = [
  { id: 1, name: "Newswire", code: "NW" },
  { id: 2, name: "Chain Watcher", code: "CW" },
  { id: 3, name: "Momentum", code: "MO" }
];

function Evidence({ decision }: { decision: Decision }) {
  const proof = decision.reasoning_verification ?? "unverified";
  const signature = decision.signature || decision.tx_signature;
  const validSignature = signature && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature);
  const proofLabel = {
    verified: "METİN SHA-256 HASH İLE EŞLEŞTİ",
    mismatch: "UYARI: GEREKÇE HASH İLE EŞLEŞMİYOR",
    missing: "HASH MEVCUT · GEREKÇE METNİ EKSİK",
    unverified: "HASH DOĞRULANAMADI · ESKİ VEYA EKSİK KAYIT"
  }[proof];
  return <div className="agent-evidence">
    <div className="agent-evidence-top">
      <strong className={decision.side === "Yes" ? "yes" : "no"}>
        {decision.side.toUpperCase()} · {probability(decision.confidence_bps)}
      </strong>
      <time>{dateTime(decision.ts)}</time>
    </div>
    {decision.market && <small>MARKET #{decision.market.market_id}</small>}
    <p>{decision.reasoning || "Gerekçe metni henüz indexlenmedi."}</p>
    <small className={`proof-status proof-${proof}`} role={proof === "mismatch" ? "alert" : undefined}>{proofLabel}</small>
    {proof === "verified" && <p className="proof-caption">Tam gerekçe metni, indexer’ın bildirdiği event hash’iyle eşleşiyor. Kaynak işlem aşağıdaki bağlantıdan incelenebilir.</p>}
    {decision.reasoning_hash && <details className="proof-details"><summary>Hash ayrıntısı</summary><code>{decision.reasoning_hash}</code></details>}
    {validSignature && <a
      href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`}
      target="_blank" rel="noopener noreferrer">İşlem kanıtı ↗</a>}
  </div>;
}

export function DecisionList({ decisions }: { decisions: Decision[] }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  if (!decisions.length) return <p className="muted">Henüz indexlenmiş agent kararı yok.</p>;

  const sorted = [...decisions].sort((a, b) => b.ts - a.ts);
  const chosen = sorted.filter(d => d.agent_id === selected);
  const history = chosen.slice(1);
  const pages = Math.ceil(history.length / 5);

  return <div className="agent-switcher">
    <div className="agent-tabs">{agents.map(agent => {
      const latest = sorted.find(d => d.agent_id === agent.id);
      return <button key={agent.id}
        className={`agent-tab ${selected === agent.id ? "selected" : ""}`}
        aria-pressed={selected === agent.id}
        onClick={() => {
          setSelected(selected === agent.id ? null : agent.id);
          setPage(0);
        }}>
        <span className="agent-tab-code">{agent.code}</span>
        <strong>{agent.name}</strong>
        <span className={latest?.side === "No" ? "no" : "yes"}>
          {latest ? `${latest.side.toUpperCase()} · ${probability(latest.confidence_bps)}` : "KARAR YOK"}
        </span>
      </button>;
    })}</div>

    {selected == null
      ? <p className="agent-tab-hint">Gerekçeyi okumak için bir agent seç.</p>
      : chosen.length ? <div className="agent-tab-content" key={selected}>
        <p className="eyebrow">SON KARAR</p>
        <Evidence decision={chosen[0]} />
        {history.length > 0 && <details className="agent-history">
          <summary>Karar geçmişi ({history.length})</summary>
          {history.slice(page * 5, page * 5 + 5).map((d, i) =>
            <details className="agent-history-row" key={`${d.ts}-${i}`}>
              <summary>
                <span className={d.side === "Yes" ? "yes" : "no"}>
                  {d.side.toUpperCase()} · {probability(d.confidence_bps)}
                </span>
                <time>{dateTime(d.ts)}</time>
              </summary>
              <Evidence decision={d} />
            </details>
          )}
          <div className="agent-history-pager">
            <button disabled={page === 0} onClick={() => setPage(page - 1)}>Önceki</button>
            <span>{page + 1} / {pages}</span>
            <button disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Sonraki</button>
          </div>
        </details>}
      </div> : <p className="muted">Bu agent için karar yok.</p>}
  </div>;
}
