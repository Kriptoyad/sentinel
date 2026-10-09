import { Connection, type AccountInfo } from "@solana/web3.js";
import idl from "@/idl/sentinel.json";
import { DEFAULT_RPC_URL, PROGRAM_ID, deriveMarketAddress } from "./solana";
import type { Market } from "./types";
import { decodeMarket } from "./marketAccount";
function mergeAccount(market: Market, account: AccountInfo<Buffer> | null): Market {
  try {
    if (!account) throw new Error("No Devnet market account yet");
    if (!account.owner.equals(PROGRAM_ID)) throw new Error("Market account owned by another program");
    const chain = decodeMarket(account.data);
    if (chain.market_id !== market.market_id || chain.market_type !== market.market_type) throw new Error("Market identity mismatch");
    return {...market,...chain,onchain_verified:true,chain_status:"Showing current Devnet account values; off-chain text is unverified"};
  } catch (e) { return {...market,onchain_verified:false,chain_status:e instanceof Error ? e.message : "Devnet account could not be verified"}; }
}
export async function verifyMarkets(markets: Market[]): Promise<Market[]> {
  if (!markets.length) return [];
  try {
    if (idl.address !== PROGRAM_ID.toBase58()) throw new Error("IDL program ID mismatch");
    const rpc = process.env.SOLANA_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL || DEFAULT_RPC_URL;
    const connection = new Connection(rpc,{commitment:"confirmed",disableRetryOnRateLimit:true});
    const result: Market[] = [];
    for (let offset=0; offset<markets.length; offset+=100) {
      const batch = markets.slice(offset,offset+100);
      const accounts = await connection.getMultipleAccountsInfo(batch.map(m=>deriveMarketAddress(m.market_id)),"confirmed");
      result.push(...batch.map((m,i)=>mergeAccount(m,accounts[i])));
    }
    return result;
  } catch { return markets.map(m=>({...m,onchain_verified:false,chain_status:"Devnet unavailable or rate limited; trading disabled"})); }
}
export async function verifyMarket(market: Market): Promise<Market> { return (await verifyMarkets([market]))[0]; }
