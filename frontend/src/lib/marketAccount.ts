import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import idl from "@/idl/sentinel.json";
type OnchainMarket = {
  market_id: string;
  market_type: "Price" | "Risk";
  probability_bps: string;
  total_yes_exposure: string;
  total_no_exposure: string;
  resolution_deadline: number;
  resolved: boolean;
  resolution_outcome: boolean | null;
  resolution_ts: number | null;
  finalized_at: number | null;
  dispute_authority: string;
  metadata_uri: string;
  collateral_mint: string;
};

class Reader {
  private offset = 0;
  constructor(private readonly data: Buffer) {}
  bytes(length: number): Buffer {
    if (length < 0 || this.offset + length > this.data.length) throw new Error("Truncated market account");
    const value = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  u8() { return this.bytes(1).readUInt8(0); }
  u16() { return this.bytes(2).readUInt16LE(0); }
  u32() { return this.bytes(4).readUInt32LE(0); }
  u64() { return this.bytes(8).readBigUInt64LE(0).toString(); }
  i64() { return Number(this.bytes(8).readBigInt64LE(0)); }
  bool() { const v = this.u8(); if (v > 1) throw new Error("Invalid boolean"); return v === 1; }
  option<T>(read: () => T): T | null {
    const tag = this.u8();
    if (tag === 0) return null;
    if (tag !== 1) throw new Error("Invalid option tag");
    return read();
  }
  pubkey() { return new PublicKey(this.bytes(32)).toBase58(); }
  string() { const len = this.u32(); if (len > 200) throw new Error("Invalid metadata URI"); return this.bytes(len).toString("utf8"); }
}

export function decodeMarket(data: Buffer): OnchainMarket {
  const reader = new Reader(data);
  const discriminator = Buffer.from(idl.accounts.find(account => account.name === "Market")!.discriminator);
  if (!reader.bytes(8).equals(discriminator)) throw new Error("Wrong account discriminator");
  const market_id = reader.u64();
  const kind = reader.u8();
  if (kind > 1) throw new Error("Unknown market type");
  reader.bytes(32); // question_hash; readable question still needs canonical hash verification
  const metadata_uri = reader.string();
  reader.pubkey(); // creator
  const collateral_mint = reader.pubkey();
  reader.pubkey(); // oracle_authority
  const dispute_authority = reader.pubkey();
  const probability_bps = String(reader.u16());
  reader.i64(); // cumulative_funding
  reader.i64(); // last_update_ts
  const total_yes_exposure = reader.u64();
  const total_no_exposure = reader.u64();
  const resolved = reader.bool();
  const resolution_outcome = reader.option(() => reader.bool());
  const resolution_ts = reader.option(() => reader.i64());
  const finalized_at = reader.option(() => reader.i64());
  const resolution_deadline = reader.i64();
  reader.u8(); // bump
  return { market_id, market_type: kind === 0 ? "Price" : "Risk", metadata_uri,
    collateral_mint, dispute_authority, probability_bps, total_yes_exposure,
    total_no_exposure, resolved, resolution_outcome, resolution_ts, finalized_at,
    resolution_deadline };
}

