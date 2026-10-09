"use client";

import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { DEFAULT_RPC_URL } from "@/lib/solana";

export function SolanaProvider({ children }: { children: React.ReactNode }) {
  const endpoint = useMemo(() => process.env.NEXT_PUBLIC_SOLANA_RPC_URL || DEFAULT_RPC_URL, []);
  const config = useMemo(() => ({ commitment: "confirmed" as const, disableRetryOnRateLimit: true }), []);
  return <ConnectionProvider endpoint={endpoint} config={config}>
    <WalletProvider wallets={[]} autoConnect>
      <WalletModalProvider>{children}</WalletModalProvider>
    </WalletProvider>
  </ConnectionProvider>;
}
