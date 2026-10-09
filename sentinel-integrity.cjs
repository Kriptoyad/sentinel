"use strict";
const { createHash } = require("node:crypto");
const ZERO_HASH = "0".repeat(64);
function hashReasoning(text) {
  if (typeof text !== "string") throw new TypeError("Reasoning must be a string");
  return createHash("sha256").update(text, "utf8").digest("hex");
}
function verification(decision) {
  const hash = decision.reasoning_hash;
  if (!hash || hash === ZERO_HASH || !/^[a-f0-9]{64}$/i.test(hash)) return "unverified";
  if (typeof decision.reasoning !== "string") return "missing";
  return hashReasoning(decision.reasoning) === hash.toLowerCase() ? "verified" : "mismatch";
}
function matches(decision, entry, marketId) {
  if (String(entry.market_id) !== String(marketId) || Number(entry.agent_id) !== Number(decision.agent_id)) return false;
  const hash = decision.reasoning_hash;
  if (hash && hash !== ZERO_HASH) {
    // Exact bytes are authoritative. Never pair a new hashed decision by time alone.
    if (hashReasoning(entry.reasoning) !== hash.toLowerCase()) return false;
    if (entry.signature) return entry.signature === decision.signature;
    return Math.abs(Number(entry.ts) - Number(decision.ts)) <= 8;
  }
  // Old zero-hash events retain their legacy text, without a verification badge.
  if (entry.signature) return entry.signature === decision.signature;
  return Math.abs(Number(entry.ts) - Number(decision.ts)) <= 8;
}
function attachReasoning(decision, entries, marketId) {
  const entry = entries.find(r => !r.used && matches(decision, r, marketId));
  if (entry) { decision.reasoning = entry.reasoning; entry.used = true; }
  return decision;
}
function expiryState(deadline, chainTime) {
  const end = BigInt(deadline.toString());
  const now = BigInt(chainTime.toString());
  return now < end ? "open" : now < end + 300n ? "grace" : "expired";
}
module.exports = { hashReasoning, verification, matches, attachReasoning, expiryState };
