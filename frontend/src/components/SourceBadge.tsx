export function SourceBadge({ source }: { source: "api" | "demo" }) {
  return <span className={`source-badge ${source}`}>{source === "api" ? "BACKEND DATA · VERIFY ON-CHAIN" : "DEMO DATA · NO ON-CHAIN ACTIVITY"}</span>;
}
