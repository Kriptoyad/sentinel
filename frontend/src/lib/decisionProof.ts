import { createHash } from "node:crypto";
import type { AgentDecision } from "./types";

// Verify exact UTF-8 bytes against the event hash reported by the indexer.
// This is NOT an independent RPC verification of the transaction event.
export function decisionProof(decision: AgentDecision): "verified" | "mismatch" | "missing" | "unverified" {
  const hash = decision.reasoning_hash;
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash) || /^0{64}$/.test(hash)) return "unverified";
  if (typeof decision.reasoning !== "string" || !decision.reasoning.length) return "missing";
  return createHash("sha256").update(decision.reasoning, "utf8").digest("hex") === hash.toLowerCase()
    ? "verified" : "mismatch";
}
