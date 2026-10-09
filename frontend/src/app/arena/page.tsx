import Link from "next/link";
import { getMarkets, getDecisions } from "@/lib/api";
import { ArenaDecisions } from "@/components/ArenaDecisions";
import { defaultArenaMarket } from "@/lib/marketPresentation";
import { SourceBadge } from "@/components/SourceBadge";


export const dynamic = "force-dynamic";
const personas = [
  { name: "Newswire", code: "NW", role: "VERIFIED REPORTS", description: "Reads sourced announcements and keeps a strict line between an allegation and a confirmed event." },
  { name: "Chain Watcher", code: "CW", role: "ON-CHAIN SIGNALS", description: "Checks program and wallet activity against a baseline. An anomaly triggers investigation, not a verdict." },
  { name: "Momentum", code: "MO", role: "MARKET STRUCTURE", description: "Studies price, volume, and time remaining. Holds when the data is too thin to support a view." }
];
export default async function Arena() {
  const markets = await getMarkets();
  const decisionResults = await Promise.all(markets.data.map(m => getDecisions(m.market_id)));
  const groups = decisionResults.map((result, index) => ({ market: markets.data[index], decisions: result.data, source: result.source }));
  return <main className="inner-page"><div className="page-intro"><p className="eyebrow">SENTINEL / AGENT ARENA</p><h1>Three minds.<br /><em>One live debate.</em></h1><p>Each agent sees a different slice of the evidence. Watch the decision trail before trusting a number.</p><SourceBadge source={markets.source} /></div>
    <div className="agent-grid">{personas.map(agent => { return <article className="agent-card" key={agent.name}><div className="agent-card-top"><span className="large-avatar">{agent.code}</span><span className="agent-index">AGENT / 0{personas.indexOf(agent) + 1}</span></div><p className="eyebrow">{agent.role}</p><h2>{agent.name}</h2><p>{agent.description}</p><div className="agent-latest"><small>Seçtiğin marketteki güncel karar ve gerekçeler aşağıda.</small></div></article>; })}</div>
    <section className="section"><div className="section-heading"><div><p className="eyebrow">DECISION HISTORY</p><h2>The public trail</h2></div></div><div className="activity-panel"><ArenaDecisions groups={groups} initialId={defaultArenaMarket(groups)} /></div></section>
    <div className="disclaimer-strip">LEADERBOARD SCORING AND THE AGENT POOL ARE NOT LIVE. NO WIN RATE OR P&L IS CLAIMED WITHOUT SETTLED MARKET HISTORY.</div>
    <p className="return-link"><Link href="/">← BACK TO MARKETS</Link></p>
  </main>;
}
