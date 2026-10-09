import Link from "next/link";
import { MarketCard } from "@/components/MarketCard";
import { SourceBadge } from "@/components/SourceBadge";
import { getMarkets, getDecisions } from "@/lib/api";
import { ArenaDecisions } from "@/components/ArenaDecisions";
import { defaultArenaMarket } from "@/lib/marketPresentation";

export const dynamic = "force-dynamic";
export default async function Home() {
  const result = await getMarkets();
  const groups = await Promise.all(result.data.map(async market => {
    const decisions = await getDecisions(market.market_id);
    return { market, decisions: decisions.data, source: decisions.source };
  }));
  return <main>
    <section className="hero"><div><p className="eyebrow"><span className="pulse" /> CONTINUOUSLY WATCHING · SOLANA</p><h1>The market<br /><em>never closes.</em></h1><p className="hero-copy">Continuously monitored prediction markets on Solana. Three signal agents explain their views; each market settles at its deadline.</p><div className="hero-actions"><a href="#markets" className="button primary">Explore markets <span>↗</span></a><Link href="/arena" className="button secondary">Meet the agents →</Link></div></div><div className="hero-art" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="orbit orbit-three"/><div className="orbit-core">S</div><span className="orbit-label label-one">MONITOR</span><span className="orbit-label label-two">EVALUATE</span><span className="orbit-label label-three">RESPOND</span></div></section>
    <section className="section" id="markets"><div className="section-heading"><div><p className="eyebrow">01 / THE WATCH</p><h2>Markets & settlements</h2></div><SourceBadge source={result.source} /></div>{result.source === "demo" && <p className="demo-note">Backend or devnet markets are not connected. All values and agent activity below are illustrative.</p>}<div className="market-grid">{result.data.map(market => <MarketCard key={market.market_id} market={market} />)}</div></section>
    <section className="section split-section"><div><p className="eyebrow">02 / THE ARENA</p><h2>Different eyes.<br />One market.</h2><p className="muted">Agents use separate evidence streams. Their reasoning is indexed off-chain; the on-chain event carries the decision hash.</p><Link href="/arena" className="text-link">OPEN AGENT ARENA ↗</Link></div><div className="activity-panel"><ArenaDecisions groups={groups} initialId={defaultArenaMarket(groups)} /></div></section>
    <div className="disclaimer-strip">RISK MARKET POOLS ARE VOLUNTARILY FUNDED. PAYOUTS ARE LIMITED TO AVAILABLE FUNDS. THIS IS NOT AN INSURANCE PRODUCT.</div>
  </main>;
}
