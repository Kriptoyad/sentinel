import type { Market } from "./types";

export type ResolutionStage = "open" | "awaiting_resolution" | "dispute_window" | "finalized" | "unknown";

export function resolutionStage(market: Market, now = Math.floor(Date.now() / 1000)): ResolutionStage {
  if (!market.resolved) return now < market.resolution_deadline ? "open" : "awaiting_resolution";
  if (market.finalized_at == null) return "unknown";
  return now < market.finalized_at ? "dispute_window" : "finalized";
}

export const stageLabel: Record<ResolutionStage, string> = {
  open: "OPEN",
  awaiting_resolution: "DEADLINE PASSED · AWAITING RESOLUTION",
  dispute_window: "PROVISIONAL · DISPUTE WINDOW",
  finalized: "FINALIZED",
  unknown: "RESOLUTION STATUS UNVERIFIED"
};
