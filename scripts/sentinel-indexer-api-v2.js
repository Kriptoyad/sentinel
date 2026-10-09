// SENTINEL — minimal indexer + REST API (hackathon MVP) — v2
//
// v2 changes:
// - Added collateral_mint to the serialized market response (contract now
//   stores it per-market since market_vault/pool_vault are ATAs of it).
// - Added MARKET_METADATA entries for the two short-deadline demo markets
//   (market_id 3 = Price, market_id 4 = Risk), used to demo the full
//   resolve -> dispute window -> claim flow live during the presentation.
// - Everything else (event subscriptions, backfill, JSON contract, decimal
//   strings for all u64/i64 fields) is unchanged from v1.
//
// Run:
//   npm install express @coral-xyz/anchor @solana/web3.js cors
//   PROGRAM_ID=3PA87yNfZD3DptejAafT2ovehCkh3xo8DhUVQoyWTw2P \
//   IDL_PATH=./sentinel.json \
//   node sentinel-indexer-api-v2.js
//
// IMPORTANT: copy the LATEST target/idl/sentinel.json (post `anchor idl
// upgrade`) into IDL_PATH before starting this — the account layout changed
// (collateral_mint field added to Market) since the first version.

const fs = require("fs");
const crypto = require("crypto");
const { hashReasoning, verification, attachReasoning, matches } = require("../sentinel-integrity.cjs");
const express = require("express");
const cors = require("cors");
const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey } = require("@solana/web3.js");

// --- Manual event log decoder ---
// anchor.EventParser silently matches zero events against this program's
// logs (an Anchor Rust 1.2.0 vs @coral-xyz/anchor JS 0.32.1 encoding
// mismatch — the same family of incompatibility that required dropping the
// programId argument from `new Program()` earlier). Rather than depend on
// that, we decode the raw "Program data: <base64>" log lines ourselves:
// Anchor's event wire format is always [8-byte sha256("event:<Name>")
// discriminator][borsh-encoded struct fields], which is stable across
// versions since it's just the runtime's sol_log_data syscall underneath.
function eventDiscriminator(name) {
  return crypto.createHash("sha256").update(`event:${name}`).digest().slice(0, 8);
}
const EVENT_DISCRIMINATORS = {
  AgentDecisionLogged: eventDiscriminator("AgentDecisionLogged"),
  ProbabilityUpdated: eventDiscriminator("ProbabilityUpdated"),
  MarketResolved: eventDiscriminator("MarketResolved"),
  ResolutionOverridden: eventDiscriminator("ResolutionOverridden"),
};
function readPubkey(buf, offset) {
  return new PublicKey(buf.slice(offset, offset + 32));
}
function decodeEventBody(name, body) {
  let o = 0;
  if (name === "AgentDecisionLogged") {
    const market = readPubkey(body, o); o += 32;
    const agentId = body.readUInt8(o); o += 1;
    const sideByte = body.readUInt8(o); o += 1;
    const side = sideByte === 0 ? { yes: {} } : { no: {} };
    const confidenceBps = body.readUInt16LE(o); o += 2;
    const reasoningHash = Buffer.from(body.slice(o, o + 32)); o += 32;
    const ts = body.readBigInt64LE(o); o += 8;
    const authority = readPubkey(body, o); o += 32;
    return { market, agentId, side, confidenceBps, reasoningHash, ts, authority };
  }
  if (name === "ProbabilityUpdated") {
    const market = readPubkey(body, o); o += 32;
    const newProbabilityBps = body.readUInt16LE(o); o += 2;
    const cumulativeFunding = body.readBigInt64LE(o); o += 8;
    const sourceTs = body.readBigInt64LE(o); o += 8;
    return { market, newProbabilityBps, cumulativeFunding, sourceTs };
  }
  if (name === "MarketResolved") {
    const market = readPubkey(body, o); o += 32;
    const outcome = body.readUInt8(o) === 1; o += 1;
    const resolutionTs = body.readBigInt64LE(o); o += 8;
    const autoResolved = body.readUInt8(o) === 1; o += 1;
    return { market, outcome, resolutionTs, autoResolved };
  }
  if (name === "ResolutionOverridden") {
    const market = readPubkey(body, o); o += 32;
    const newOutcome = body.readUInt8(o) === 1; o += 1;
    const ts = body.readBigInt64LE(o); o += 8;
    return { market, newOutcome, ts };
  }
  throw new Error("unknown event name: " + name);
}
function decodeEventsFromLogs(logMessages) {
  const events = [];
  const stack = [];
  for (const log of logMessages || []) {
    const invoke = log.match(/^Program (\S+) invoke \[(\d+)\]$/);
    if (invoke) { stack.length = Number(invoke[2]) - 1; stack.push(invoke[1]); continue; }
    const finish = log.match(/^Program (\S+) (?:success|failed:)/);
    if (finish) { if (stack.at(-1) === finish[1]) stack.pop(); continue; }
    if (stack.at(-1) !== PROGRAM_ID.toBase58()) continue;
    const m = log.match(/^Program data: (.+)$/);
    if (!m) continue;
    let buf;
    try {
      buf = Buffer.from(m[1], "base64");
    } catch {
      continue;
    }
    if (buf.length < 8) continue;
    const disc = buf.subarray(0, 8);
    const body = buf.subarray(8);
    for (const [name, d] of Object.entries(EVENT_DISCRIMINATORS)) {
      if (disc.equals(d)) {
        try {
          events.push({ name, data: decodeEventBody(name, body) });
        } catch (e) {
          console.warn(`decodeEventsFromLogs: failed to decode ${name}:`, e.message);
        }
        break;
      }
    }
  }
  return events;
}

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "3PA87yNfZD3DptejAafT2ovehCkh3xo8DhUVQoyWTw2P"
);
const IDL_PATH = process.env.IDL_PATH || "./sentinel.json";
const DB_PATH = "./sentinel-db.json";
const PORT = process.env.PORT || 8787;

// --- Static metadata not stored on-chain (only question_hash is) ---
// market_id 1/2: the long-horizon "always-on" markets (agent pricing demo).
// market_id 3/4: short-deadline demo markets created specifically to show the
// full resolve -> dispute window -> claim flow live during the presentation.
// Fill in the exact resolution_deadline values once the setup script reports
// the real unix timestamps (the deadline itself is read from on-chain data,
// this object only carries the human-readable question/rules text).
const MARKET_METADATA = {
  1: {
    question: "SOL, resolution_deadline anında $250'ın üzerinde mi olacak?",
    resolution_methodology: "deadline_snapshot",
    resolution_rules:
      "resolution_deadline anındaki Pyth SOL/USD fiyatı $250'ın üzerindeyse EVET. " +
      "Haftanın başka bir anında $250'ı geçmiş olması sonucu etkilemez.",
  },
  2: {
    question:
      "Demo Protokolü, resolution_deadline'a kadar $10.000+ değerinde doğrulanmış bir exploit'e uğrayacak mı?",
    resolution_methodology: "deadline_snapshot",
    resolution_rules:
      "Doğrulanmış exploit = yetkisiz fon çıkışı ($10.000 eşdeğeri üzeri) + protokolün resmi " +
      "açıklaması veya 2 bağımsız kaynağın teyidi. Deadline'a kadar doğrulanmış olay olmazsa " +
      "otomatik HAYIR ile çözülür. Çözümden sonra 1 saatlik itiraz penceresi var. " +
      "NOT: şu anki MVP'de bu otomatik doğrulanmıyor, güvenilir oracle attestation'ına dayanıyor.",
  },
  3: {
    question:
      "[DEMO] SOL, resolution_deadline anında $250'ın üzerinde mi olacak? (canlı sunum demosu, ~90 dk vadeli)",
    resolution_methodology: "deadline_snapshot",
    resolution_rules:
      "resolution_deadline anındaki fiyata göre EVET/HAYIR. Bu market, tam resolve → itiraz " +
      "penceresi → claim akışını sunum sırasında canlı göstermek için kısa vadeli açıldı; " +
      "Market 1 ile aynı kurallara tabi, sadece süresi kısaltıldı.",
  },
  4: {
    question:
      "[DEMO] Demo Protokolü, resolution_deadline'a kadar doğrulanmış bir exploit'e uğrayacak mı? (canlı sunum demosu, ~90 dk vadeli)",
    resolution_methodology: "deadline_snapshot",
    resolution_rules:
      "Doğrulanmış exploit tanımı Market 2 ile aynı. Bu market, risk pool'un fonlanıp kazanan " +
      "tarafa pro-rata bonus ödemesi yapmasını sunum sırasında canlı göstermek için kısa " +
      "vadeli açıldı ve gerçek test-USDC ile fonlanmış bir pool içeriyor.",
  },
};

const AGENT_NAMES = { 1: "Newswire", 2: "Chain Watcher", 3: "Momentum" };

// --- In-memory store ---
let db = {
  markets: {},
  pools: {},
  probabilityHistory: {},
  agentDecisions: {},
  agentReasoning: {},
};

if (fs.existsSync(DB_PATH)) {
  try {
    db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch (e) {
    console.warn("Could not parse existing db file, starting fresh:", e.message);
  }
}

function persist() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
setInterval(persist, 15_000);

// --- Helpers ---
function bpsToString(n) {
  return (n ?? 0).toString();
}
function u64ToString(n) {
  return n?.toString ? n.toString() : String(n ?? 0);
}
function marketIdFromAccount(marketAccount) {
  return u64ToString(marketAccount.marketId);
}

function serializeMarket(marketId, m, pool) {
  const meta = MARKET_METADATA[marketId] || {};
  return {
    market_id: String(marketId),
    market_type: m.marketType.price ? "Price" : "Risk",
    question: meta.question || "(question metadata not set)",
    resolution_methodology: meta.resolution_methodology || "deadline_snapshot",
    resolution_rules: meta.resolution_rules || "",
    probability_bps: bpsToString(m.probabilityBps),
    probability_history: db.probabilityHistory[marketId] || [],
    resolution_deadline: Number(m.resolutionDeadline),
    resolved: m.resolved,
    resolution_outcome: m.resolutionOutcome,
    finalized_at: m.finalizedAt ? Number(m.finalizedAt) : null,
    total_yes_exposure: u64ToString(m.totalYesExposure),
    total_no_exposure: u64ToString(m.totalNoExposure),
    collateral_mint: m.collateralMint.toBase58(),
    oracle_authority: m.oracleAuthority.toBase58(),
    dispute_authority: m.disputeAuthority.toBase58(),
    pool_total_deposited: pool ? u64ToString(pool.totalDeposited) : null,
    pool_total_claimed: pool ? u64ToString(pool.totalClaimed) : null,
  };
}

// --- Anchor setup ---
async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(anchor.web3.Keypair.generate()), // read-only, no signing needed here
    {}
  );
  const program = new anchor.Program(idl, provider);

  // market pubkey (base58) -> market_id, needed to map events back to our keys
  if (!db.marketPubkeyToId) db.marketPubkeyToId = {};

  async function backfill() {
    const markets = await program.account.market.all();
    for (const { publicKey, account } of markets) {
      const id = marketIdFromAccount(account);
      db.markets[id] = account;
      db.marketPubkeyToId[publicKey.toBase58()] = id;
    }
    const pools = await program.account.pool.all();
    for (const { account } of pools) {
      const owningMarket = markets.find(
        (m) => m.publicKey && m.publicKey.equals(account.market)
      );
      if (owningMarket) {
        const id = marketIdFromAccount(owningMarket.account);
        db.pools[id] = account;
      }
    }
    console.log(`Backfilled ${markets.length} markets, ${pools.length} pools`);
  }
  await backfill();

  // --- Polling-based event ingestion ---
  // NOTE: program.addEventListener() relies on a WebSocket logsSubscribe
  // connection, which public devnet RPC endpoints often don't support
  // reliably (silently never fires). Polling getSignaturesForAddress is
  // slower (~every 20s) but uses plain HTTP RPC calls, so it's guaranteed
  // to work the same way backfill() already does.
  if (!db.seenSignatures) db.seenSignatures = [];
  const seenSet = new Set(db.seenSignatures);

  // Shared, order-independent reasoning matcher.
  // db.agentReasoningLog: [{ market_id, agent_id, ts, reasoning, used }]
  // Whichever arrives first (the on-chain event via polling, or the crank
  // bot's POST) leaves an entry; whichever arrives second searches this log
  // with a timestamp tolerance (blockTime can be a few seconds off between
  // the crank bot's own tx fetch and the indexer's later poll) and consumes
  // the match. This works regardless of arrival order.
  if (!db.agentReasoningLog) db.agentReasoningLog = [];
  function handleEvent(name, ev, blockTime, signature) {
    // EventParser emits names as they appear in the IDL, which can be
    // lowerCamelCase ("agentDecisionLogged") rather than the PascalCase used
    // in the Rust source ("AgentDecisionLogged") — normalize before matching.
    const normalizedName = name.charAt(0).toUpperCase() + name.slice(1);

    const id = db.marketPubkeyToId[ev.market?.toBase58?.()];
    if (!id) return; // event from a market we don't know about yet

    if (normalizedName === "ProbabilityUpdated") {
      if (!db.probabilityHistory[id]) db.probabilityHistory[id] = [];
      db.probabilityHistory[id].push({
        ts: Number(ev.sourceTs) || blockTime,
        value_bps: ev.newProbabilityBps,
      });
    } else if (normalizedName === "MarketResolved" || normalizedName === "ResolutionOverridden") {
      // cheap: just let the next backfill() pick up the new resolved state
    } else if (normalizedName === "AgentDecisionLogged") {
      if (!db.agentDecisions[id]) db.agentDecisions[id] = [];
      const ts = Number(ev.ts.toString());
      const decision = {
        agent_id: ev.agentId,
        agent_name: AGENT_NAMES[ev.agentId] || `Agent ${ev.agentId}`,
        side: ev.side.yes ? "Yes" : "No",
        confidence_bps: ev.confidenceBps,
        reasoning_hash: Buffer.from(ev.reasoningHash).toString("hex"),
        reasoning: null,
        ts,
        signature,
      };
      attachReasoning(decision, db.agentReasoningLog, id);
      db.agentDecisions[id].push(decision);
    }
  }

  let pollRunning = false;
  async function pollEvents() {
    if (pollRunning) return;
    pollRunning = true;
    try { await ingestEvents(); }
    finally { pollRunning = false; }
  }
  async function ingestEvents() {
    let sigInfos;
    try {
      sigInfos = await connection.getSignaturesForAddress(PROGRAM_ID, { limit: 15 }, "confirmed");
    } catch (e) {
      console.warn("pollEvents: could not fetch signatures:", e.message);
      return;
    }
    const fresh = sigInfos.filter((s) => !seenSet.has(s.signature)).reverse(); // oldest first
    for (const sigInfo of fresh) {
      try {
        const tx = await connection.getTransaction(sigInfo.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        if (!tx?.meta) continue; // RPC can return null before the transaction is available.
        if (tx.meta.err) { seenSet.add(sigInfo.signature); continue; }
        if (tx.meta.logMessages) {
          for (const ev of decodeEventsFromLogs(tx.meta.logMessages)) {
            handleEvent(ev.name, ev.data, tx.blockTime, sigInfo.signature);
          }
        }
      } catch (e) {
        console.warn(`pollEvents: failed to process ${sigInfo.signature.slice(0, 8)}...:`, e.message);
        continue; // Retry failed RPC/decoder reads rather than marking them processed.
      }
      seenSet.add(sigInfo.signature);
      await new Promise((r) => setTimeout(r, 400)); // small gap to avoid 429s on public RPC
    }
    if (fresh.length > 0) {
      db.seenSignatures = [...seenSet].slice(-1000);
      persist();
      console.log(`Processed ${fresh.length} new transaction(s)`);
    }
  }

  await pollEvents();
  setInterval(() => backfill().catch(e => console.warn("backfill failed:", e.message)), 45_000);
  setInterval(() => pollEvents().catch(e => console.warn("poll failed:", e.message)), 40_000);

  // --- REST API ---
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/markets", (req, res) => {
    const result = Object.entries(db.markets).map(([id, m]) =>
      serializeMarket(id, m, db.pools[id])
    );
    res.json({ markets: result });
  });

  app.get("/markets/:id", (req, res) => {
    const id = req.params.id;
    const m = db.markets[id];
    if (!m) return res.status(404).json({ error: "market not found" });
    res.json(serializeMarket(id, m, db.pools[id]));
  });

  app.get("/markets/:id/agent-decisions", (req, res) => {
    const id = req.params.id;
    res.json((db.agentDecisions[id] || []).map(d => {
      const status = verification(d);
      return { ...d, reasoning_verified: status === "verified", reasoning_verification: status };
    }));
  });

  app.post("/internal/agent-decision", (req, res) => {
    const { market_id, agent_id, ts, reasoning, signature } = req.body;
    if (!/^\d+$/.test(String(market_id)) || !Number.isInteger(Number(agent_id)) ||
        Number(agent_id) < 1 || !Number.isSafeInteger(Number(ts)) ||
        typeof reasoning !== "string" || !reasoning.length ||
        (signature !== undefined && (typeof signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)))) {
      return res.status(400).json({ error: "Invalid market_id, agent_id, ts, reasoning or signature" });
    }
    const entry = { market_id: String(market_id), agent_id: Number(agent_id),
      ts: Number(ts), reasoning, signature, used: false };
    const list = db.agentDecisions[market_id] || [];
    const match = list.find(d => matches(d, entry, market_id));
    if (match) {
      attachReasoning(match, [entry], market_id);
    } else {
      const sameTx = signature && list.find(d => d.signature === signature && Number(d.agent_id) === Number(agent_id));
      if (sameTx) return res.status(409).json({ error: "Reasoning does not match on-chain hash" });
      if (!db.agentReasoningLog.some(r => !r.used && r.signature === signature &&
          String(r.market_id) === String(market_id) && Number(r.agent_id) === Number(agent_id) &&
          hashReasoning(r.reasoning) === hashReasoning(reasoning))) {
        db.agentReasoningLog.push(entry);
      }
      if (db.agentReasoningLog.length > 500) {
        db.agentReasoningLog = db.agentReasoningLog.filter(r => !r.used).slice(-200);
      }
    }

    persist();
    res.json({ ok: true });
  });

  app.listen(PORT, () => console.log(`Sentinel API listening on :${PORT}`));
}

main().catch((e) => {
  console.error("Fatal error starting indexer:", e);
  process.exit(1);
});
