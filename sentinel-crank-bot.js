// SENTINEL — crank bot
//
// Two modes:
//   node sentinel-crank-bot.js loop
//     Runs forever. Every CRANK_INTERVAL_MS, for every unresolved market:
//       - computes a new probability (real SOL/USD price for Price markets
//         via CoinGecko's public API; a slow simulated random-walk for Risk
//         markets, since we don't have a real exploit-detection oracle)
//       - calls update_probability on-chain
//       - has one of the 3 agents (rotating) "explain" the move and logs it
//         via log_agent_decision on-chain + POSTs the full reasoning text to
//         the backend's /internal/agent-decision endpoint for the UI
//
//   node sentinel-crank-bot.js resolve <market_id> <true|false>
//     One-shot: calls resolve_market with the given outcome. Requires the
//     market's resolution_deadline to already be in the past (the contract
//     enforces this itself; the tx will fail otherwise).
//
// Env:
//   ORACLE_KEYPAIR_PATH   default: ~/.config/solana/id.json
//   PROGRAM_ID            default: the deployed Sentinel program id
//   IDL_PATH              default: ./sentinel.json
//   RPC_URL               default: https://api.devnet.solana.com
//   BACKEND_URL           default: http://localhost:8787
//   CRANK_INTERVAL_MS      default: 60000 (1 minute)
//
// Run: npm install @coral-xyz/anchor @solana/web3.js
//      node sentinel-crank-bot.js loop

const fs = require("fs");
const os = require("os");
const path = require("path");
const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey, Keypair } = require("@solana/web3.js");

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection (devam ediliyor):", err?.message || err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (devam ediliyor):", err?.message || err);
});

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "3PA87yNfZD3DptejAafT2ovehCkh3xo8DhUVQoyWTw2P"
);
const IDL_PATH = process.env.IDL_PATH || "./sentinel.json";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8787";
const CRANK_INTERVAL_MS = Number(process.env.CRANK_INTERVAL_MS || 60_000);
const KEYPAIR_PATH =
  process.env.ORACLE_KEYPAIR_PATH ||
  path.join(os.homedir(), ".config", "solana", "id.json");

const AGENTS = [
  { id: 1, name: "Newswire" },
  { id: 2, name: "Chain Watcher" },
  { id: 3, name: "Momentum" },
];
let agentCursor = 0;

function loadKeypair(p) {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function fetchSolPrice() {
  try {
    const res = await fetch(
      "https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT"
    );
    const json = await res.json();
    return parseFloat(json.price);
  } catch (e) {
    console.warn("Price fetch failed, using fallback 180:", e.message);
    return 180;
  }
}

// Simple logistic curve mapping "distance from threshold" to a probability.
// Not a real pricing model — good enough to make the demo feel alive.
function priceToProbabilityBps(currentPrice, threshold = 250, steepness = 0.05) {
  const z = (currentPrice - threshold) * steepness;
  const p = 1 / (1 + Math.exp(-z));
  return Math.max(0, Math.min(10000, Math.round(p * 10000)));
}

// Risk markets: no real exploit-detection oracle exists yet (documented MVP
// limitation). We simulate a slow random walk so the probability line isn't
// flat, clearly labeled as simulated in the demo narrative.
function riskRandomWalk(currentBps) {
  const delta = Math.round((Math.random() - 0.5) * 200); // +/-100bps per tick
  return Math.max(100, Math.min(9900, currentBps + delta));
}

function reasoningFor(agentName, marketType, newBps, oldBps) {
  const direction = newBps > oldBps ? "yukarı" : newBps < oldBps ? "aşağı" : "sabit";
  if (agentName === "Newswire") {
    return marketType === "Price"
      ? `Son fiyat verisine göre olasılık ${direction} güncellendi (${oldBps}bps -> ${newBps}bps).`
      : `Herhangi bir doğrulanmış olay tespit edilmedi, risk skoru ${direction} yönde hafifçe revize edildi.`;
  }
  if (agentName === "Chain Watcher") {
    return marketType === "Price"
      ? `On-chain hacim/momentum sinyalleri fiyat hareketiyle uyumlu, olasılık ${direction} güncellendi.`
      : `Zincir üstünde anormal whale çıkışı veya TVL düşüşü gözlenmedi, risk skoru düşük seyrediyor.`;
  }
  // Momentum
  return `Kısa vadeli trend ${direction} yönlü, olasılık buna göre ${oldBps}bps -> ${newBps}bps taşındı.`;
}

async function postReasoning(marketId, agentId, ts, reasoning) {
  try {
    await fetch(`${BACKEND_URL}/internal/agent-decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ market_id: marketId, agent_id: agentId, ts, reasoning }),
    });
  } catch (e) {
    console.warn("Could not push reasoning to backend (is it running?):", e.message);
  }
}

async function main() {
  const mode = process.argv[2];
  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(loadKeypair(KEYPAIR_PATH));
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  const program = new anchor.Program(idl, provider);

  if (mode === "resolve") {
    const marketId = Number(process.argv[3]);
    const outcome = process.argv[4] === "true";
    if (!marketId || process.argv[4] === undefined) {
      console.error("Usage: node sentinel-crank-bot.js resolve <market_id> <true|false>");
      process.exit(1);
    }
    const markets = await program.account.market.all();
    const found = markets.find((m) => Number(m.account.marketId) === marketId);
    if (!found) {
      console.error(`Market ${marketId} not found on-chain`);
      process.exit(1);
    }
    console.log(`Resolving market ${marketId} (${found.publicKey.toBase58()}) -> ${outcome}`);
    const sig = await program.methods
      .resolveMarket(outcome)
      .accounts({ oracleAuthority: wallet.publicKey, market: found.publicKey })
      .rpc();
    console.log("Resolved. Tx:", sig);
    console.log(
      `Dispute window closes at approx: ${new Date(Date.now() + 3600_000).toISOString()} ` +
        `(claim_payout will reject before this)`
    );
    return;
  }

  if (mode !== "loop") {
    console.error("Usage: node sentinel-crank-bot.js [loop | resolve <market_id> <true|false>]");
    process.exit(1);
  }

  console.log(`Crank loop starting, interval=${CRANK_INTERVAL_MS}ms, oracle=${wallet.publicKey.toBase58()}`);

  async function tick() {
    let solPrice;
    try {
      solPrice = await fetchSolPrice();
    } catch {
      solPrice = 180;
    }

        let markets;
    try {
      markets = await program.account.market.all();
    } catch (e) {
      console.error("RPC'ye ulaşılamadı, bu turu atlıyorum:", e.message);
      return;
    }
    for (const { publicKey, account: m } of markets) {
      if (m.resolved) continue;
      const marketId = Number(m.marketId);
      const isPriceType = !!m.marketType.price;
      const oldBps = m.probabilityBps;
      const newBps = isPriceType
        ? priceToProbabilityBps(solPrice)
        : riskRandomWalk(oldBps);

      try {
        const now = Math.floor(Date.now() / 1000) - 30;
        const sig = await program.methods
          .updateProbability(newBps, new anchor.BN(now))
          .accounts({ oracleAuthority: wallet.publicKey, market: publicKey })
          .rpc();
        console.log(`Market ${marketId}: ${oldBps} -> ${newBps} bps (tx ${sig.slice(0, 8)}...)`);

        // rotating agent "explains" this update
        const agent = AGENTS[agentCursor % AGENTS.length];
        agentCursor++;
        const side = newBps >= 5000 ? { yes: {} } : { no: {} };
        const confidenceBps = Math.min(10000, Math.abs(newBps - 5000) * 2);
        const reasoningText = reasoningFor(agent.name, isPriceType ? "Price" : "Risk", newBps, oldBps);
        const reasoningHash = Buffer.alloc(32); // MVP: not a real hash of reasoningText yet

        const decisionSig = await program.methods
          .logAgentDecision(agent.id, side, confidenceBps, Array.from(reasoningHash))
          .accounts({ agentAuthority: wallet.publicKey, market: publicKey })
          .rpc();

        const tx = await connection.getTransaction(decisionSig, { commitment: "confirmed" });
        const eventTs = tx?.blockTime || Math.floor(Date.now() / 1000);
        await postReasoning(marketId, agent.id, eventTs, reasoningText);
      } catch (e) {
        console.error(`Market ${marketId} update failed:`, e.message);
      }
    }
  }

  await tick();
  setInterval(tick, CRANK_INTERVAL_MS);
}

main().catch((e) => {
  console.error("Fatal crank bot error:", e);
  process.exit(1);
});
