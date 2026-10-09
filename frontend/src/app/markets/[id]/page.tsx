import { OpenPositionForm } from "@/components/OpenPositionForm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getMarket, getDecisions } from "@/lib/api";
import { SourceBadge } from "@/components/SourceBadge";
import { ProbabilityChart } from "@/components/ProbabilityChart";
import { DecisionList } from "@/components/DecisionList";
import { dateTime, probability, testUsdc } from "@/lib/format";
import { marketTitle, marketReading } from "@/lib/marketPresentation";
import { resolutionStage, stageLabel } from "@/lib/resolution";

export const dynamic = "force-dynamic";
export default async function MarketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [marketResult, decisionResult] = await Promise.all([getMarket(id), getDecisions(id)]);
  const market = marketResult.data;
  if (!market) notFound();
  const stage = resolutionStage(market);
  const reading = marketReading(market);
  return <main className="inner-page market-page"><p className="return-link"><Link href="/">← ALL MARKETS</Link></p><div className="market-heading"><div><p className="eyebrow">MARKET #{market.market_id} / {market.market_type.toUpperCase()} / {stageLabel[stage]}</p><h1>{marketTitle(market.question)}</h1><SourceBadge source={marketResult.source} />{marketResult.source === "api" && <p className="data-caption">DEVNET: {market.chain_status ?? "Verification pending"}</p>}</div><div className="probability-box"><small>{reading.label}</small><strong className={market.resolved && reading.value === "NO" ? "outcome-no" : undefined}>{reading.value}</strong>{market.resolved && <p className="last-probability">Son çözüm öncesi olasılık: {probability(market.probability_bps)}</p>}<span>{marketResult.source === "api" ? market.onchain_verified ? "ACCOUNT VALUE MATCHES DEVNET" : "BACKEND REPORTED · UNVERIFIED" : "ILLUSTRATIVE VALUE"}</span></div></div>
    <div className="detail-grid"><section className="detail-panel chart-panel"><div className="panel-title"><span>PROBABILITY HISTORY</span><span>INDEXED EVENTS</span></div><ProbabilityChart history={market.probability_history ?? []} /><div className="detail-stats"><div><small>YES EXPOSURE</small><strong>{testUsdc(market.total_yes_exposure)}</strong></div><div><small>NO EXPOSURE</small><strong>{testUsdc(market.total_no_exposure)}</strong></div><div><small>RESOLUTION DEADLINE</small><strong>{dateTime(market.resolution_deadline)}</strong></div></div><p className="data-caption">Collateral amounts use the demo mint’s 6 decimals. Test tokens have no asserted dollar value.</p></section><section className="detail-panel"><div className="panel-title"><span>RESOLUTION CONTRACT</span><span>READ FIRST</span></div><p className="rules">{market.resolution_rules}</p><div className="rule-flag">DEADLINE SNAPSHOT: {market.market_type === "Price" ? "Only the price at the deadline counts; an earlier price crossing does not count." : "The oracle attests whether a qualifying exploit was confirmed by the deadline. This MVP uses a trusted oracle."} Deadline: {dateTime(market.resolution_deadline)}.</div><div className="resolution-status"><strong>{stageLabel[stage]}</strong>{market.resolved && <p>{stage === "finalized" ? "Final outcome:" : "Provisional outcome:"} {market.resolution_outcome == null ? "unavailable" : market.resolution_outcome ? "YES" : "NO"}</p>}{market.finalized_at != null && <p>Dispute window ends: {dateTime(market.finalized_at)}</p>}{stage === "dispute_window" && <p>Claims are locked during the one-hour dispute window. The dispute authority may override the outcome.</p>}{stage === "awaiting_resolution" && <p>If no oracle resolution was recorded by the deadline, the permissionless expiry path becomes available five minutes after the deadline and proposes NO, followed by the dispute window.</p>}{stage === "finalized" && <p>The dispute window has ended. An eligible winning position can claim its share of the market stakes and any funded pool bonus. An empty bonus pool does not prevent stake settlement.</p>}{market.dispute_authority && <p>Dispute authority: <code>{market.dispute_authority}</code></p>}</div><p className="data-caption">Question and rules are off-chain metadata. Current account values are read from Devnet; the position form checks the pool disclaimer hash before signing.</p></section></div>
    <section className="section"><div className="section-heading"><div><p className="eyebrow">AGENT DECISION LOG</p><h2>What changed their minds?</h2></div><SourceBadge source={decisionResult.source} /></div><div className="activity-panel"><DecisionList decisions={decisionResult.data} /></div></section>
    {market.market_type === "Risk" && <div className="disclaimer-strip">THIS IS NOT INSURANCE. ANY PAYOUT IS A PRO-RATA SHARE OF AN ACTUALLY FUNDED POOL AND IS NOT GUARANTEED.</div>}
    <OpenPositionForm market={market} verified={marketResult.source === "api" && market.onchain_verified === true} />
  </main>;
}
