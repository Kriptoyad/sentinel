# Sentinel

Solana Devnet prediction markets with an agent decision trail, a one-hour dispute window, and voluntary pool payouts.

## What is implemented

- Anchor program for fixed-deadline Price and Risk markets, positions, closing positions, and pro-rata settlement.
- Three heuristic signal agents: Newswire reads headlines, Chain Watcher observes network TPS, and Momentum observes recent market probability readings.
- Crank probability updates and on-chain agent decision events carrying SHA-256 hashes of exact UTF-8 reasoning text.
- An indexer/API with probability history and transaction-linked agent reasoning.
- A Next.js frontend with Phantom wallet connection, Devnet SOL/test-token balances, position and payout panels, agent/market selection, and text/hash matching.
- Permissionless fallback NO resolution after deadline plus a 300-second oracle grace period. Claims remain locked for the following 3600-second dispute window.

## Devnet deployment

Program ID: `3PA87yNfZD3DptejAafT2ovehCkh3xo8DhUVQoyWTw2P`

[Program on Solana Explorer](https://explorer.solana.com/address/3PA87yNfZD3DptejAafT2ovehCkh3xo8DhUVQoyWTw2P?cluster=devnet)

Test collateral mint: `6jnypkLny5TGDrJLw2vB7fTDu6iKRrZXmdmfKpd8JNC8` (6 decimals). These are test tokens, not redeemable USDC.

Verified in the development session: Phantom connection, a 1-token open/close position flow, and a Market 4 CLI claim increasing its NO-wallet balance from 0 to 100 test tokens (80 from market stakes plus 20 pool bonus).

[Market 4 claim transaction](https://explorer.solana.com/tx/3brZ87v35skW1As5xDaaL1LaJykK4Frq2kkDpxdK84Z1u8AwZ9djHmcXm4P3ubjg7D44qPhzTXwDxn6pzJUQ3ohd?cluster=devnet)

## Repository

- `programs/sentinel`: Anchor/Rust contract.
- `idl/sentinel.json`: public client interface.
- `sentinel-crank-bot-v2.js`: crank and heuristic signal agents.
- `sentinel-integrity.cjs`: reasoning matching and expiry helpers.
- `scripts/sentinel-indexer-api-v2.js`: indexer and REST API.
- `frontend`: Next.js application.
- `tests`: contract/client and backend checks; frontend has its own tests.

## Run the frontend and API

Use Node 24 and npm. From the repository root:

```bash
npm install
cd scripts
RPC_URL=https://api.devnet.solana.com PROGRAM_ID=3PA87yNfZD3DptejAafT2ovehCkh3xo8DhUVQoyWTw2P IDL_PATH=./sentinel.json node sentinel-indexer-api-v2.js
```

In another terminal:

```bash
cd frontend
cp .env.example .env.local
npm install
WATCHPACK_POLLING=true npm run dev -- --webpack --port 3000
```

The indexer listens on port 8787. Open http://localhost:3000. A private RPC endpoint may be needed for sustained polling; keep its credentials outside Git. If API access fails, the UI labels fallback data as demo and disables unverified trading.

## Crank and expiry actions

The crank signs real Devnet updates using an oracle-authorized local keypair. No private keypairs are included. Configure `KEYPAIR_PATH`, `RPC_URL`, `IDL_PATH` and `BACKEND_URL` locally.

```bash
IDL_PATH=./idl/sentinel.json BACKEND_URL=http://127.0.0.1:8787 node sentinel-crank-bot-v2.js loop
```

Starting the loop can propose NO for unresolved expired markets. This is a timeout fallback, not a historical price attestation. The dispute authority can correct a proposed result before finalization.

## Validation

```bash
node --test tests/sentinel-backend.test.cjs
cd frontend
node --test tests/*.cjs
npm run build -- --webpack
```

Anchor contract builds and local tests require the matching Solana/Anchor toolchain and local configuration. Program deployment keypairs and demo wallets must be supplied or generated locally. An existing deployed program's upgrade keypair is never published here.

## MVP scope and limitations

This MVP uses finite markets and pari-mutuel settlement; it is not a full perpetual exchange. Agents use heuristics, not autonomous LLM trading wallets. The risk probability update is simulated, the price signal uses Binance spot data, and oracle resolution remains a trusted attestation. Metadata mentioning Pyth describes the intended price resolution rule; the current implementation does not automatically prove a signed Pyth deadline snapshot.

Text/hash matching compares exact text with the indexer's reported event hash. It does not independently fetch and verify the transaction event in the frontend or prove that a prediction is correct. Old zero-hash decisions remain unverified. The indexer has a limited polling window and the internal reasoning endpoint is not authenticated; this is a Devnet prototype, not a production service.

Voluntary pool payouts are limited to available funds. **This is not insurance.** No publicly hosted demo URL is claimed by this repository yet.
