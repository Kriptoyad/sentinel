"use client";
import { useId, useState } from "react";
import Link from "next/link";
import type { ArenaGroup } from "@/lib/marketPresentation";
import { marketTitle } from "@/lib/marketPresentation";
import { DecisionList } from "./DecisionList";
import { SourceBadge } from "./SourceBadge";

export function ArenaDecisions({ groups, initialId }: { groups: ArenaGroup[]; initialId: string }) {
  const [selected, setSelected] = useState(initialId);
  const selectId = useId();
  const group = groups.find(g => g.market.market_id === selected) ?? groups.find(g => g.market.market_id === initialId) ?? groups[0];
  if (!group) return <p className="muted">Gösterilecek market yok.</p>;
  return <div>
    <div className="arena-market-picker">
      <label htmlFor={selectId}>KARARLARINI İZLEDİĞİN MARKET</label>
      <select id={selectId} value={group.market.market_id} onChange={e => setSelected(e.target.value)}>
        {groups.map(g => <option key={g.market.market_id} value={g.market.market_id}>
          #{g.market.market_id} · {g.market.market_type} · {g.market.resolved ? "Çözüldü" : "Çözülmedi"} · {marketTitle(g.market.question)}
        </option>)}
      </select>
      <div className="arena-market-meta"><SourceBadge source={group.source} /><Link href={`/markets/${group.market.market_id}`}>MARKET #{group.market.market_id} ↗</Link></div>
      <p className="arena-market-question">{marketTitle(group.market.question)}</p>
    </div>
    <DecisionList key={group.market.market_id} decisions={group.decisions} />
  </div>;
}
