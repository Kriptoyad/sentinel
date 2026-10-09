export function Logo({ size = 34 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-label="Sentinel radar mark" role="img">
    <circle cx="20" cy="20" r="3" fill="currentColor" />
    <path d="M12 20a8 8 0 0 1 8-8M20 28a8 8 0 0 0 8-8M7 20A13 13 0 0 1 20 7M20 33a13 13 0 0 0 13-13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <path d="M20 2v3M38 20h-3M20 38v-3M2 20h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>;
}
