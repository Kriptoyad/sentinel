import { PublicKey } from "@solana/web3.js";

export const CLUSTER = "devnet" as const;
export const PROGRAM_ID = new PublicKey("3PA87yNfZD3DptejAafT2ovehCkh3xo8DhUVQoyWTw2P");
export const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
export const PROGRAM_EXPLORER_URL = `https://explorer.solana.com/address/${PROGRAM_ID.toBase58()}?cluster=devnet`;

// The Rust contract uses [b"market", market_id.to_le_bytes()]. A JS number can
// silently lose precision above 2^53, so the ID is parsed as a decimal bigint.
export function deriveMarketAddress(marketId: string): PublicKey {
  if (!/^(0|[1-9]\d*)$/.test(marketId)) throw new Error("market_id must be a decimal u64 string");
  const id = BigInt(marketId);
  if (id > (1n << 64n) - 1n) throw new Error("market_id exceeds u64");
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, id, true);
  return PublicKey.findProgramAddressSync([new TextEncoder().encode("market"), bytes], PROGRAM_ID)[0];
}
