/**
 * Helpers for parsing the app's timeframe strings (e.g., `now()-7d`) into
 * day counts and into the right interval label for SFM/timeseries queries.
 */

/** Parse a timeframe string like `now()-7d` into a number of days. */
export function timeframeDays(tf: string): number {
  const m = tf.match(/^now\(\)-(\d+)([dhm])$/);
  if (!m) return 7;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  if (unit === "d") return n;
  if (unit === "h") return n / 24;
  return n / (24 * 60);
}

/** Pick a sensible bucket interval for SFM timeseries based on the timeframe. */
export function intervalForTf(tf: string): string {
  if (tf.includes("1h")) return "1m";
  if (tf.includes("6h")) return "5m";
  if (tf.includes("1d")) return "30m";
  if (tf.includes("7d")) return "1h";
  if (tf.includes("14d")) return "3h";
  if (tf.includes("30d")) return "6h";
  return "1h";
}
