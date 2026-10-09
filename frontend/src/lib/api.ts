import { decisionProof } from "./decisionProof";
import { demoDecisions, demoMarkets } from "./demo";
import type { AgentDecision, DataResult, Market } from "./types";
import { verifyMarket, verifyMarkets } from "./onchain";

const base = process.env.SENTINEL_API_URL?.replace(/\/$/, "");
async function request<T>(path: string): Promise<T> {
  if (!base) throw new Error("Backend URL is not configured");
  const response = await fetch(`${base}${path}`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Backend returned ${response.status}`);
  return response.json() as Promise<T>;
}
function marketId(value: string | number | bigint): string { return String(value); }
function normalizeMarket(raw: Market & { market_id: string | number }): Market {
  if (raw.resolution_methodology !== "deadline_snapshot") throw new Error("Unknown resolution methodology");
  return {
    ...raw, market_id: marketId(raw.market_id), probability_bps: String(raw.probability_bps),
    probability_history: (raw.probability_history ?? []).map(point => ({ ...point, value_bps: String(point.value_bps) })),
    total_yes_exposure: String(raw.total_yes_exposure), total_no_exposure: String(raw.total_no_exposure)
  };
}
export async function getMarkets(): Promise<DataResult<Market[]>> {
  try {
    const raw = await request<{ markets: (Market & { market_id: string | number })[] }>("/markets");
    const response = raw.markets;
    if (!Array.isArray(response)) throw new Error("Invalid /markets response");
    return { data: await verifyMarkets(response.map(normalizeMarket)), source: "api" };
  } catch (error) { console.error("[DEBUG getMarkets]", error); return { data: demoMarkets, source: "demo", error: String(error) }; }
}
export async function getMarket(id: string): Promise<DataResult<Market | null>> {
  try {
    const response = await request<Market & { market_id: string | number }>(`/markets/${encodeURIComponent(id)}`);
    return { data: await verifyMarket(normalizeMarket(response)), source: "api" };
  } catch (error) { return { data: demoMarkets.find(m => m.market_id === id) ?? null, source: "demo", error: String(error) }; }
}
export async function getDecisions(id: string): Promise<DataResult<AgentDecision[]>> {
  try {
    const response = await request<AgentDecision[]>(`/markets/${encodeURIComponent(id)}/agent-decisions`);
    if (!Array.isArray(response)) throw new Error("Invalid decisions response");
    return { data: response.map(decision => ({ ...decision, confidence_bps: String(decision.confidence_bps),
      tx_signature: decision.signature || decision.tx_signature,
      reasoning_verification: decisionProof(decision),
      reasoning_verified: decisionProof(decision) === "verified" })), source: "api" };
  } catch (error) { return { data: demoDecisions[id] ?? [], source: "demo", error: String(error) }; }
}
