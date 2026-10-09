import type { Market, AgentDecision } from "./types";
import { resolutionStage } from "./resolution";
import { probability } from "./format";

export function marketTitle(question: string): string {
  return question.replace(/^\[DEMO\]\s*/i, "")
    .replace(/\s*\(canlı sunum demosu[^)]*\)\s*$/i, "")
    .replace(/resolution_deadline'a/g, "son tarihe")
    .replace(/resolution_deadline/g, "son tarih");
}
export function marketReading(market: Market, now?: number) {
  if (!market.resolved) return { label: "MARKET PROBABILITY", value: probability(market.probability_bps), final: false };
  const final = resolutionStage(market, now) === "finalized";
  return { label: final ? "KESİN SONUÇ" : "ÇÖZÜM SONUCU · İTİRAZ DURUMUNU KONTROL ET",
    value: market.resolution_outcome == null ? "BELİRSİZ" : market.resolution_outcome ? "YES" : "NO", final };
}
export type ArenaGroup = { market: Market; decisions: AgentDecision[]; source: "api" | "demo" };
export function defaultArenaMarket(groups: ArenaGroup[], now = Math.floor(Date.now() / 1000)): string {
  const latest = (g: ArenaGroup) => Math.max(0, ...g.decisions.map(d => d.ts));
  const open = groups.filter(g => !g.market.resolved && g.market.resolution_deadline > now && g.source === "api");
  return [...(open.length ? open : groups)].sort((a, b) => latest(b) - latest(a))[0]?.market.market_id ?? "";
}
