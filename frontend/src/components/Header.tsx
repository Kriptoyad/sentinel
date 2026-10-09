import Link from "next/link";
import { Logo } from "./Logo";
import { WalletControl } from "./WalletControl";
import { PROGRAM_EXPLORER_URL } from "@/lib/solana";

export function Header() {
  return <header className="site-header">
    <Link href="/" className="brand"><Logo /><span>SENTINEL<small>THE MARKET NEVER CLOSES</small></span></Link>
    <nav aria-label="Main navigation"><Link href="/">Markets</Link><Link href="/arena">Agent Arena</Link></nav>
    <a className="network-tag" href={PROGRAM_EXPLORER_URL} target="_blank" rel="noopener noreferrer" title="View deployed program on Solana Explorer">◉ DEVNET PROGRAM ↗</a>
    <WalletControl />
  </header>;
}
