import type { AgentDecision, Market } from "./types";

const now = Math.floor(Date.now() / 1000);
export const demoMarkets: Market[] = [
  {
    market_id: "1", market_type: "Price",
    question: "Will SOL be above $250 at the deadline?",
    resolution_rules: "Demo rule: YES if the designated SOL/USD oracle price is above $250 at the exact deadline. Oracle selection and dispute procedure must be finalized before launch.",
    probability_bps: "6200",
    probability_history: [51, 54, 52, 58, 56, 60, 59, 62].map((n, i) => ({ ts: now - (7 - i) * 3600, value_bps: String(n * 100) })),
    total_yes_exposure: "1250000000", total_no_exposure: "800000000", resolved: false,
    resolution_methodology: "deadline_snapshot", resolution_deadline: now + 7 * 86400, onchain_verified: false
  },
  {
    market_id: "2", market_type: "Risk",
    question: "Will Demo Protocol have a confirmed exploit within 30 days?",
    resolution_rules: "Demo only. Confirmation authority, covered incident definition, deadline, and dispute process are not finalized. This is not insurance.",
    probability_bps: "800",
    probability_history: [4, 4, 5, 4, 5, 7, 6, 8].map((n, i) => ({ ts: now - (7 - i) * 3600, value_bps: String(n * 100) })),
    total_yes_exposure: "160000000", total_no_exposure: "920000000", resolved: false,
    resolution_methodology: "deadline_snapshot", resolution_deadline: now + 30 * 86400, onchain_verified: false
  }
];

export const demoDecisions: Record<string, AgentDecision[]> = {
  "1": [
    { agent_id: 1, agent_name: "Newswire", side: "Yes", confidence_bps: "6100", reasoning: "Demo reasoning: no verified new report; maintain the current assessment.", ts: now - 180 },
    { agent_id: 2, agent_name: "Chain Watcher", side: "No", confidence_bps: "4800", reasoning: "Demo reasoning: supplied activity alone does not establish a directional price signal.", ts: now - 520 },
    { agent_id: 3, agent_name: "Momentum", side: "Yes", confidence_bps: "7000", reasoning: "Demo reasoning: the supplied sample price window shows positive momentum.", ts: now - 890 }
  ],
  "2": [
    { agent_id: 2, agent_name: "Chain Watcher", side: "Yes", confidence_bps: "1400", reasoning: "Demo reasoning: investigate an unusual activity pattern; this is not proof of an exploit.", ts: now - 250 },
    { agent_id: 1, agent_name: "Newswire", side: "No", confidence_bps: "300", reasoning: "Demo reasoning: no confirmed incident appears in the supplied evidence.", ts: now - 740 },
    { agent_id: 3, agent_name: "Momentum", side: "No", confidence_bps: "1100", reasoning: "Demo reasoning: market movement alone cannot confirm a protocol exploit.", ts: now - 1100 }
  ]
};
