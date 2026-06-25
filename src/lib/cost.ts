/**
 * Cost utilities. Cost rate is expressed in USD per datapoint.
 * Default: $45.50 per 100,000,000 DP = $4.55e-7 per DP.
 */

export const DEFAULT_RATE_USD_PER_DP = 4.55e-7;

/** @deprecated alias for backwards compat */
export const DEFAULT_RATE_CENTS_PER_DP = DEFAULT_RATE_USD_PER_DP;

export function costUSD(datapoints: number, ratePerDpUSD: number): number {
  return datapoints * ratePerDpUSD;
}

export function fmtUSD(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(2)}K`;
  if (abs >= 1) return `$${v.toFixed(2)}`;
  if (abs >= 0.01) return `$${v.toFixed(4)}`;
  if (abs >= 0.0001) return `$${v.toFixed(6)}`;
  if (abs === 0) return "$0.00";
  // very small — show in cents
  const cents = v * 100;
  if (Math.abs(cents) >= 0.01) return `${cents.toFixed(4)}¢`;
  return `${cents.toExponential(2)}¢`;
}

/**
 * Whether a metric.key is billable under Dynatrace DPS pricing.
 * https://docs.dynatrace.com/docs/license/capabilities/metrics/dps-metrics-ingest
 *
 * Rules:
 * - Most `dt.*` keys are non-billable platform metrics.
 * - EXCEPT these `dt.*` prefixes (billable): `dt.cloud.aws.*`, `dt.cloud.azure.*`,
 *   `dt.osservice.*`, `dt.service.*`.
 *   (`dt.service.*` is conservatively treated as billable — Full-Stack OneAgent
 *   source vs. Grail-billed source cannot be inferred from metric.key alone.)
 * - Plus the specific NAM keys in BILLABLE_NAM_KEYS.
 * - Specific cloud keys overridden back to non-billable (NON_BILLABLE_DT_CLOUD_OVERRIDES).
 * - `legacy.containers.*`, `legacy.dotnet.perform.*`, `legacy.tomcat.*` are non-billable.
 * - All other (custom) metrics are billable.
 *
 * Not modeled: metrics stored in the `dt_system_metrics` bucket are non-billable
 * regardless of key — bucket info isn't on `metric.series`.
 */
const NON_BILLABLE_DT_CLOUD_OVERRIDES = new Set([
  "dt.cloud.aws.az.running",
  "dt.cloud.azure.region.vms.initializing",
  "dt.cloud.azure.region.vms.running",
  "dt.cloud.azure.region.vms.stopped",
  "dt.cloud.azure.vm_scale_set.vms.initializing",
  "dt.cloud.azure.vm_scale_set.vms.running",
  "dt.cloud.azure.vm_scale_set.vms.stopped",
]);

const BILLABLE_NAM_KEYS = new Set([
  "dt.synthetic.multi_protocol.request.availability",
  "dt.synthetic.multi_protocol.request.executions",
  "dt.synthetic.multi_protocol.icmp.success_rate",
  "dt.synthetic.multi_protocol.icmp.packets_sent",
  "dt.synthetic.multi_protocol.icmp.packets_received",
  "dt.synthetic.multi_protocol.icmp.round_trip_time",
  "dt.synthetic.multi_protocol.tcp.connection_time",
  "dt.synthetic.multi_protocol.dns.resolution_time",
]);

const NON_BILLABLE_LEGACY_PREFIXES = [
  "legacy.containers.",
  "legacy.dotnet.perform.",
  "legacy.tomcat.",
];

const BILLABLE_DT_PREFIXES = [
  "dt.cloud.aws.",
  "dt.cloud.azure.",
  "dt.osservice.",
  "dt.service.",
];

export function isBillableMetric(metricKey: string): boolean {
  if (!metricKey) return false;

  for (const p of NON_BILLABLE_LEGACY_PREFIXES) {
    if (metricKey.startsWith(p)) return false;
  }

  if (metricKey.startsWith("dt.")) {
    if (NON_BILLABLE_DT_CLOUD_OVERRIDES.has(metricKey)) return false;
    for (const p of BILLABLE_DT_PREFIXES) {
      if (metricKey.startsWith(p)) return true;
    }
    if (BILLABLE_NAM_KEYS.has(metricKey)) return true;
    return false;
  }

  return true;
}
