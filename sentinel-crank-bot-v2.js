// SENTINEL — crank bot v2
//
// v2 change: the 3 agents now read genuinely different signals instead of
// rotating through one shared template. Each tick, ALL THREE agents log
// their own decision (their own side/confidence/reasoning) for every
// unresolved market, so the Agent Arena can show real disagreement.
//
//   Newswire      -> real crypto news headlines (CryptoCompare free API),
//                    simple keyword sentiment on articles mentioning Solana.
//   Chain Watcher -> real Solana mainnet network activity (TPS via
//                    getRecentPerformanceSamples) vs a baseline.
//   Momentum      -> purely technical: the bot's own recent probability
//                    history for that market, trend direction only.
//
// Modes (unchanged):
//   node sentinel-crank-bot.js loop
//   node sentinel-crank-bot.js resolve <market_id> <true|false>
//
// Env additions:
//   MAINNET_RPC_URL   default: https://api.mainnet-beta.solana.com
//   NEWS_REFRESH_TICKS default: 5 (only re-fetch news every N ticks)

const fs = require("fs");
const os = require("os");
const { hashReasoning, expiryState } = require("./sentinel-integrity.cjs");
const path = require("path");
const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey, Keypair, SYSVAR_CLOCK_PUBKEY } = require("@solana/web3.js");

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection (devam ediliyor):", err?.message || err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (devam ediliyor):", err?.message || err);
});

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "3PA87yNfZD3DptejAafT2ovehCkh3xo8DhUVQoyWTw2P"
);
const IDL_PATH = process.env.IDL_PATH || "./sentinel.json";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8787";
const CRANK_INTERVAL_MS = Number(process.env.CRANK_INTERVAL_MS || 60_000);
const NEWS_REFRESH_TICKS = Number(process.env.NEWS_REFRESH_TICKS || 5);
const KEYPAIR_PATH =
  process.env.ORACLE_KEYPAIR_PATH ||
  path.join(os.homedir(), ".config", "solana", "id.json");

const AGENTS = {
  NEWSWIRE: { id: 1, name: "Newswire" },
  CHAIN_WATCHER: { id: 2, name: "Chain Watcher" },
  MOMENTUM: { id: 3, name: "Momentum" },
};

const POSITIVE_WORDS = ["surge", "rally", "adopt", "partnership", "bullish", "growth", "record", "upgrade", "gain", "soar"];
const NEGATIVE_WORDS = ["hack", "exploit", "crash", "bearish", "drop", "lawsuit", "ban", "decline", "sell-off", "vulnerability"];

let tickCounter = 0;
let cachedNewsSignal = { score: 0, snippet: "Henüz haber verisi çekilmedi." };
const localProbHistory = {}; // marketId -> [bps,...]

function loadKeypair(p) {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

async function fetchSolPrice() {
  try {
    const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT");
    const json = await res.json();
    return parseFloat(json.price);
  } catch (e) {
    console.warn("Price fetch failed, using fallback 180:", e.message);
    return 180;
  }
}

// --- Newswire: real headlines via CoinTelegraph's free Solana-tagged RSS feed ---
async function fetchNewsSignal() {
  try {
    const res = await fetch("https://cointelegraph.com/rss/tag/solana");
    const xml = await res.text();
    // crude but dependency-free RSS parsing: grab <item>...<title>TEXT</title>
    const itemMatches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
    if (itemMatches.length === 0) {
      return { score: 0, snippet: "Solana ile ilgili yeni bir haber bulunamadı, nötr kalıyorum." };
    }
    const firstItem = itemMatches[0][1];
    const titleMatch = firstItem.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/);
    const descMatch = firstItem.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/);
    const title = titleMatch ? titleMatch[1] : "";
    const desc = descMatch ? descMatch[1] : "";
    const text = (title + " " + desc).toLowerCase();
    let pos = 0, neg = 0;
    for (const w of POSITIVE_WORDS) if (text.includes(w)) pos++;
    for (const w of NEGATIVE_WORDS) if (text.includes(w)) neg++;
    const score = clamp((pos - neg) / 3, -1, 1);
    return { score, snippet: title.slice(0, 140) || "Başlık ayrıştırılamadı, nötr kalıyorum." };
  } catch (e) {
    console.warn("News fetch failed:", e.message);
    return { score: 0, snippet: "Haber kaynağına ulaşılamadı, nötr kalıyorum." };
  }
}

// --- Chain Watcher: real Solana mainnet TPS vs a baseline ---
async function fetchChainSignal(mainnetConnection) {
  try {
    const samples = await mainnetConnection.getRecentPerformanceSamples(4);
    if (!samples.length) return { score: 0, snippet: "Ağ performans verisi alınamadı." };
    const avgTps =
      samples.reduce((sum, s) => sum + s.numTransactions / s.samplePeriodSecs, 0) / samples.length;
    const baseline = 3000; // rough mainnet baseline TPS for comparison
    const score = clamp((avgTps - baseline) / baseline, -1, 1);
    return { score, snippet: `Mainnet ortalama TPS: ${avgTps.toFixed(0)} (referans: ${baseline})` };
  } catch (e) {
    console.warn("Chain signal fetch failed:", e.message);
    return { score: 0, snippet: "Mainnet RPC'sine ulaşılamadı, nötr kalıyorum." };
  }
}

// --- Momentum: purely the bot's own recent probability history for this market ---
function momentumSignal(marketId, currentBps) {
  if (!localProbHistory[marketId]) localProbHistory[marketId] = [];
  const hist = localProbHistory[marketId];
  hist.push(currentBps);
  if (hist.length > 5) hist.shift();
  if (hist.length < 2) {
    return { score: 0, snippet: "Henüz yeterli geçmiş veri yok, nötr kalıyorum." };
  }
  const slope = (hist[hist.length - 1] - hist[0]) / hist.length;
  const score = clamp(slope / 50, -1, 1);
  return {
    score,
    snippet: `Son ${hist.length} okumada trend: ${slope >= 0 ? "yukarı" : "aşağı"} (${hist.join(" -> ")})`,
  };
}

function scoreToSideAndConfidence(score) {
  const side = score >= 0 ? { yes: {} } : { no: {} };
  const confidenceBps = clamp(Math.round(Math.abs(score) * 10000), 500, 9500);
  return { side, confidenceBps };
}

// --- Price/risk probability update logic (unchanged from v1) ---
function priceToProbabilityBps(currentPrice, threshold = 250, steepness = 0.05) {
  const z = (currentPrice - threshold) * steepness;
  const p = 1 / (1 + Math.exp(-z));
  return clamp(Math.round(p * 10000), 0, 10000);
}
function riskRandomWalk(currentBps) {
  const delta = Math.round((Math.random() - 0.5) * 200);
  return clamp(currentBps + delta, 100, 9900);
}

async function postReasoning(marketId, agentId, ts, reasoning, signature) {
  try {
    const response = await fetch(`${BACKEND_URL}/internal/agent-decision`, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ market_id: marketId, agent_id: agentId, ts, reasoning, signature }),
    });
    if (!response.ok) throw new Error(`Backend HTTP ${response.status}`);
  } catch (e) {
    console.warn("Could not push reasoning to backend (is it running?):", e.message);
  }
}

async function logAgentDecision(program, connection, wallet, marketPubkey, marketId, agent, score, snippet) {
  const { side, confidenceBps } = scoreToSideAndConfidence(score);
  const reasoningHash = Buffer.from(hashReasoning(snippet), "hex");
  try {
    const sig = await program.methods
      .logAgentDecision(agent.id, side, confidenceBps, Array.from(reasoningHash))
      .accounts({ agentAuthority: wallet.publicKey, market: marketPubkey })
      .rpc();
    const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const eventTs = tx?.blockTime || Math.floor(Date.now() / 1000);
    await postReasoning(marketId, agent.id, eventTs, snippet, sig);
    console.log(`  [${agent.name}] score=${score.toFixed(2)} side=${side.yes ? "Yes" : "No"} conf=${confidenceBps} -> ${snippet}`);
  } catch (e) {
    console.error(`  [${agent.name}] log failed:`, e.message);
  }
}

async function main() {
  const mode = process.argv[2];
  const connection = new Connection(RPC_URL, "confirmed");
  const mainnetConnection = new Connection(MAINNET_RPC_URL, "confirmed");
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

  let tickRunning = false;
  async function tick() {
    if (tickRunning) return;
    tickRunning = true;
    try { await runTick(); }
    catch (e) { console.error("Crank tick failed:", e.message); }
    finally { tickRunning = false; }
  }
  async function runTick() {
    tickCounter++;

    if (tickCounter % NEWS_REFRESH_TICKS === 1) {
      cachedNewsSignal = await fetchNewsSignal();
    }
    const chainSignal = await fetchChainSignal(mainnetConnection);

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

    const clock = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed");
    if (!clock || clock.data.length < 40) throw new Error("Chain clock unavailable; tick skipped");
    const chainTime = clock.data.readBigInt64LE(32);

    for (const { publicKey, account: m } of markets) {
      if (m.resolved) continue;
      const marketId = Number(m.marketId);
      const state = expiryState(m.resolutionDeadline, chainTime);
      if (state !== "open") {
        if (state === "grace") {
          console.log(`Market ${marketId}: deadline passed; waiting for 300-second oracle grace`);
        } else {
          try {
            const sig = await program.methods.resolveExpired()
              .accounts({ caller: wallet.publicKey, market: publicKey }).rpc();
            const resolved = await program.account.market.fetch(publicKey);
            console.log(`Market ${marketId}: fallback NO proposed. Tx: ${sig}`);
            console.log(`Dispute window closes at: ${new Date(Number(resolved.finalizedAt.toString()) * 1000).toISOString()}`);
          } catch (e) { console.error(`Market ${marketId} resolve_expired failed:`, e.message); }
        }
        continue;
      }
      const isPriceType = !!m.marketType.price;
      const oldBps = m.probabilityBps;
      const newBps = isPriceType ? priceToProbabilityBps(solPrice) : riskRandomWalk(oldBps);

      try {
        const now = Math.floor(Date.now() / 1000) - 30;
        const sig = await program.methods
          .updateProbability(newBps, new anchor.BN(now))
          .accounts({ oracleAuthority: wallet.publicKey, market: publicKey })
          .rpc();
        console.log(`Market ${marketId}: ${oldBps} -> ${newBps} bps (tx ${sig.slice(0, 8)}...)`);
      } catch (e) {
        console.error(`Market ${marketId} update failed:`, e.message);
        continue;
      }

      const momentum = momentumSignal(marketId, newBps);

      await logAgentDecision(
        program, connection, wallet, publicKey, marketId,
        AGENTS.NEWSWIRE, cachedNewsSignal.score, cachedNewsSignal.snippet
      );
      await logAgentDecision(
        program, connection, wallet, publicKey, marketId,
        AGENTS.CHAIN_WATCHER, chainSignal.score, chainSignal.snippet
      );
      await logAgentDecision(
        program, connection, wallet, publicKey, marketId,
        AGENTS.MOMENTUM, momentum.score, momentum.snippet
      );
    }
  }

  await tick();
  setInterval(tick, CRANK_INTERVAL_MS);
}

main().catch((e) => {
  console.error("Fatal crank bot error:", e);
  process.exit(1);
});
