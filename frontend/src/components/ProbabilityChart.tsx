import { probability, shortTime } from "@/lib/format";
export function ProbabilityChart({ history, compact = false }: { history: {ts:number; value_bps:string}[]; compact?:boolean }) {
  const unique = new Map<number,number>();
  for (const point of history) {
    try {
      const value = Number(BigInt(point.value_bps));
      if (Number.isFinite(point.ts) && point.ts > 0 && value >= 0 && value <= 10000) unique.set(point.ts,value);
    } catch { /* malformed indexed values are omitted */ }
  }
  const data = [...unique].sort((a,b)=>a[0]-b[0]);
  if (data.length < 2) return <div className="chart-empty">Probability history will appear after updates.</div>;
  const values = data.map(p=>p[1]);
  const min = Math.max(0,values.reduce((a,b)=>Math.min(a,b))-700);
  const max = Math.min(10000,values.reduce((a,b)=>Math.max(a,b))+700);
  const start = data[0][0], end = data[data.length-1][0];
  const span = Math.max(1,max-min);
  const stride = Math.max(1,Math.ceil(data.length/500));
  const sampled = data.filter((_,i)=>i%stride===0 || i===data.length-1);
  const points = sampled.map(([ts,value])=>`${(ts-start)/(end-start)*100},${93-(value-min)/span*85}`).join(" ");
  return <div className={compact ? "chart compact" : "chart"}>
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`Probability over time, latest ${probability(values[values.length-1])}`}>
      <path d="M0 25H100 M0 50H100 M0 75H100" className="chart-grid"/><polyline points={points} className="chart-line"/>
    </svg>
    {!compact && <div className="chart-labels"><span>{shortTime(start)} · SCALE {probability(min)}–{probability(max)}</span><span>{shortTime(end)} · {probability(values[values.length-1])}</span></div>}
  </div>;
}
