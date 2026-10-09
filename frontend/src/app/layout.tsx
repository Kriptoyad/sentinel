import { LiveRefresh } from "@/components/LiveRefresh";
import type { Metadata } from "next";
import { Header } from "@/components/Header";
import { SolanaProvider } from "@/components/SolanaProvider";
import { PROGRAM_EXPLORER_URL } from "@/lib/solana";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./globals.css";

export const metadata: Metadata = { title: "Sentinel | Agent Market Arena", description: "An agent arena for continuously priced probability markets on Solana." };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><SolanaProvider><div className="app-shell"><Header /><LiveRefresh />{children}<footer className="footer"><a href={PROGRAM_EXPLORER_URL} target="_blank" rel="noopener noreferrer">SENTINEL / DEVNET PROGRAM ↗</a><span>DEVNET · Test collateral · Verify every transaction on Solana Explorer.</span></footer></div></SolanaProvider></body></html>;
}
