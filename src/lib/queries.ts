import { runDql, runDqlChunks, N } from "./dql";

export interface MetricKeyRow {
  metric_key: string;
  series: number;
  // estimated daily datapoints assuming 1-min resolution = 1440/day per series (heuristic)
  estDailyDatapoints: number;
}

export interface SourceRow {
  source: string;
  total: number;
}

export interface ChannelRow {
  channel: string;
  total: number;
}

const PREFIXES = [
  "dt.",
  "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
  "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
  "_",
];

/**
 * In-memory TTL cache for expensive deterministic DQL fetches. Caches the
 * Promise (not the resolved value), so concurrent callers share a single
 * in-flight request — important because multiple pages mount simultaneously
 * and each calls `fetchAllMetricCardinality("now()-2h")`. Failed promises are
 * evicted so retries don't get stuck on a bad result.
 */
type CacheEntry<T> = { value: Promise<T>; expires: number };
const _cache = new Map<string, CacheEntry<any>>();
const DEFAULT_TTL_MS = 5 * 60 * 1000;

function cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = _cache.get(key);
  if (hit && hit.expires > now) return hit.value as Promise<T>;
  const value = loader().catch((e) => {
    _cache.delete(key);
    throw e;
  });
  _cache.set(key, { value, expires: now + ttlMs });
  return value;
}

/** Clear all cached query results. Call from a manual "Refresh" action. */
export function invalidateQueriesCache(): void {
  _cache.clear();
}

/**
 * Fetch series cardinality grouped by metric.key, chunked by metric-key prefix
 * to avoid the per-query scan/result limit and merge results.
 *
 * `dt.` is queried as one chunk (huge), then a-z, 0-9 individually for the rest.
 * Any metric.key that does NOT start with "dt." and starts with a single letter is
 * captured by its first-character bucket. We dedupe by metric.key just in case.
 *
 * Optional `topN`: keep only the N highest-cardinality metrics. Use this on
 * pages that only ever render a top-N view (CostPage, TopMetricsPage) to avoid
 * holding 50k+ rows in memory just to discard most of them downstream.
 */
export async function fetchAllMetricCardinality(
  timeframe: string = "now()-2h",
  to?: string,
  topN?: number
): Promise<MetricKeyRow[]> {
  const key = `cardinality|${timeframe}|${to ?? ""}|${topN ?? ""}`;
  return cached(key, DEFAULT_TTL_MS, () => _fetchAllMetricCardinality(timeframe, to, topN));
}

async function _fetchAllMetricCardinality(
  timeframe: string,
  to?: string,
  topN?: number
): Promise<MetricKeyRow[]> {
  const range = to ? `from:${timeframe}, to:${to}` : `from:${timeframe}`;
  const queries = PREFIXES.map(
    (p) => `fetch metric.series, ${range}
| filter startsWith(metric.key, "${p}")
| summarize series = count(), by:{metric.key}`
  );
  const recs = await runDqlChunks(queries, 4);
  const map = new Map<string, number>();
  for (const r of recs) {
    const key = r["metric.key"] as string;
    if (!key) continue;
    const s = N(r.series);
    // keep max — duplicates across overlapping prefixes shouldn't happen but be safe
    if ((map.get(key) ?? 0) < s) map.set(key, s);
  }
  const out: MetricKeyRow[] = [];
  map.forEach((series, metric_key) => {
    out.push({
      metric_key,
      series,
      estDailyDatapoints: series * 1440,
    });
  });
  out.sort((a, b) => b.series - a.series);
  return topN && topN > 0 ? out.slice(0, topN) : out;
}

/** Total ingested datapoints over a timeframe (using SFM metric — actual measurement). */
export async function fetchTotalIngestSeries(
  timeframe: string,
  intervalLabel: string
): Promise<{ start: number; interval: number; values: number[] } | null> {
  const recs = await runDql(
    `timeseries dp = sum(dt.sfm.server.metrics.ingest.external_datapoints), from:${timeframe}, interval:${intervalLabel}`
  );
  if (!recs.length) return null;
  const r = recs[0];
  const tf = r.timeframe;
  const interval = N(r.interval);
  return {
    start: tf?.start ? new Date(tf.start).getTime() : Date.now(),
    interval,
    values: (r.dp || []).map((v: any) => N(v)),
  };
}

/** Top sources by ingested datapoints over the timeframe. */
export async function fetchTopSources(timeframe: string): Promise<SourceRow[]> {
  const recs = await runDql(
    `timeseries dp = sum(dt.sfm.server.metrics.ingest.external_datapoints), by:{source}, from:${timeframe}
| fieldsAdd total = arraySum(dp)
| fields source, total
| sort total desc`
  );
  return recs.map((r) => ({ source: String(r.source ?? "unknown"), total: N(r.total) }));
}

/** Datapoints by ingest channel. */
export async function fetchByChannel(timeframe: string): Promise<ChannelRow[]> {
  const recs = await runDql(
    `timeseries dp = sum(dt.sfm.server.metrics.ingest.external_datapoints), by:{dt.ingest.channel}, from:${timeframe}
| fieldsAdd total = arraySum(dp)
| fields channel = dt.ingest.channel, total
| sort total desc`
  );
  return recs.map((r) => ({ channel: String(r.channel ?? "unknown"), total: N(r.total) }));
}

/** Time series per source (for forecasting per source). */
export async function fetchSourceSeries(
  timeframe: string,
  intervalLabel: string,
  topN: number
): Promise<{ source: string; values: number[]; total: number }[]> {
  const recs = await runDql(
    `timeseries dp = sum(dt.sfm.server.metrics.ingest.external_datapoints), by:{source}, from:${timeframe}, interval:${intervalLabel}
| fieldsAdd total = arraySum(dp)
| sort total desc
| limit ${topN}`
  );
  return recs.map((r) => ({
    source: String(r.source ?? "unknown"),
    total: N(r.total),
    values: (r.dp || []).map((v: any) => N(v)),
  }));
}

/** For a SPECIFIC metric.key, fetch real daily datapoint count. Used in detail panel.
 *
 * Uses interval:1h (not interval:1d) because daily-rollup aggregation drastically
 * undercounts raw ingested datapoints — the hourly resolution reads closer to raw
 * data and matches the reference billing formula (count at interval:1m summed over
 * the day). Hourly values are then summed into daily buckets for the chart.
 */
export async function fetchMetricDailyDatapoints(
  metricKey: string,
  timeframe: string
): Promise<{ values: number[]; total: number }> {
  const recs = await runDql(
    `timeseries dp = count(${metricKey}), from:${timeframe}, interval:1h`
  );
  if (!recs.length) return { values: [], total: 0 };
  const hourly: number[] = (recs[0].dp || []).map((v: any) => N(v));
  // Roll up 24 hourly buckets into each calendar day
  const daily: number[] = [];
  for (let i = 0; i < hourly.length; i += 24) {
    daily.push(hourly.slice(i, i + 24).reduce((a, b) => a + b, 0));
  }
  const total = hourly.reduce((a, b) => a + b, 0);
  return { values: daily, total };
}

/** Series count per source/extension for a given metric key. */
export async function fetchMetricBySource(
  metricKey: string,
  timeframe: string
): Promise<{ source: string; series: number }[]> {
  const recs = await runDql(
    `fetch metric.series, from:${timeframe}
| filter metric.key == "${metricKey}"
| summarize s = count(), by:{dt.metrics.source}
| sort s desc`
  );
  return recs.map((r) => ({ source: String(r["dt.metrics.source"] ?? "unknown"), series: N(r.s) }));
}

/** Fetch ALL series records for a specific metric.key (with all dimension fields inline). */
export async function fetchAllSeriesFor(
  metricKey: string,
  timeframe: string,
  maxRecords = 100000
): Promise<any[]> {
  return runDql(
    `fetch metric.series, from:${timeframe}
| filter metric.key == "${metricKey}"`,
    { maxRecords }
  );
}

/**
 * Fetch all distinct DQL query strings executed against the metrics table.
 * Used to detect "idle" metrics (in ingest but never queried).
 *
 * Server-side dedupes by query_string. Cap is intentionally lower than the
 * default — beyond ~50k distinct queries the index build dominates and the
 * marginal benefit is negligible (idle-detection just needs to know if a
 * metric was referenced at all).
 */
export async function fetchMetricQueryStrings(timeframe: string = "now()-30d"): Promise<string[]> {
  const key = `metric_query_strings|${timeframe}`;
  return cached(key, DEFAULT_TTL_MS, () => _fetchMetricQueryStrings(timeframe));
}

async function _fetchMetricQueryStrings(timeframe: string): Promise<string[]> {
  const recs = await runDql(
    `fetch dt.system.events, from:${timeframe}
| filter event.kind == "QUERY_EXECUTION_EVENT" and table == "metrics" and isNotNull(query_string)
| fieldsAdd query_string = substring(query_string, from:0, to:2048)
| dedup {query_string}
| fields query_string
| limit 100000`,
    { maxRecords: 100000 }
  );
  return recs.map((r) => String(r.query_string ?? "")).filter(Boolean);
}

/**
 * Tokenize a corpus of DQL query strings into a multiset of identifiers and
 * quoted-string tokens. This yields to the event loop between chunks so the
 * page stays responsive on large inputs.
 *
 * Returns a Map<token, occurrence_count>. Lookup is O(1) per metric key,
 * vs. the previous O(metrics × blob_length) indexOf scan which froze the UI.
 */
export async function buildQueryTokenIndex(
  queries: string[],
  onProgress?: (done: number, total: number) => void
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  // Match bare identifiers (metric.key.here) and contents of double-quoted strings.
  const tokenRe = /"([^"\n]+)"|([a-zA-Z_][a-zA-Z0-9_.]*)/g;
  const CHUNK = 500;
  for (let i = 0; i < queries.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, queries.length);
    for (let j = i; j < end; j++) {
      const q = queries[j].toLowerCase();
      tokenRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = tokenRe.exec(q)) !== null) {
        const t = m[1] ?? m[2];
        if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    onProgress?.(end, queries.length);
    // Yield to the event loop so the UI can paint / handle input.
    await new Promise((r) => setTimeout(r, 0));
  }
  return counts;
}
