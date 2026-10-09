export const probability = (bps: string | number) => {
  const value = BigInt(bps);
  if (value < 0n || value > 10000n) return "—";
  const whole = value / 100n;
  const fraction = (value % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}%`;
};
export const dateTime = (ts: number) => new Date(ts * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
export const shortTime = (ts: number) => new Date(ts * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
export const units = (value: string) => `${BigInt(value).toLocaleString("en-US")} raw units`;

export const testUsdc = (raw: string | bigint) => {
  const n = BigInt(raw);
  return `${n / 1000000n}.${(n % 1000000n).toString().padStart(6, "0")} test-USDC`;
};
