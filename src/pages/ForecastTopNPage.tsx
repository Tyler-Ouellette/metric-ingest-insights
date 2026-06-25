import React, { useEffect, useMemo, useState } from "react";
import { Card, Loader, Stat } from "../components/Common";
import { LineChart } from "../components/LineChart";
import { runDqlChunks, N } from "../lib/dql";
import { fetchAllMetricCardinality } from "../lib/queries";
import { fmtNum, linearForecast } from "../lib/forecast";
import { costUSD, fmtUSD } from "../lib/cost";
import { useSettings } from "../state/SettingsContext";

interface Props { topN: number; }

interface MetricForecast {
  metric_key: string;
  series: number;
  history: number[];
  forecast: number[];
  upper: number[];
  lower: number[];
  total: number;
  projected: number;
  slope: number;
  r2: number;
}

const HISTORY_DAYS = 30;
const HORIZON_DAYS = 30;

export const ForecastTopNPage: React.FC<Props> = ({ topN }) => {
  const { rateCentsPerDp } = useSettings();
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState("Identifying top metric keys by cardinality...");
  const [rows, setRows] = useState<MetricForecast[]>([]);
  const [sortBy, setSortBy] = useState<"projected" | "growth" | "current">("projected");

  useEffect(() => {
    let abort = false;
    setLoading(true);
    setProgress("Identifying top metric keys by cardinality...");
    setRows([]);
    (async () => {
      const all = await fetchAllMetricCardinality("now()-2h");
      if (abort) return;
      const top = all.slice(0, topN);
      setProgress(`Fetching ${HISTORY_DAYS}d history for ${top.length} metrics (chunked)...`);

      // Build one timeseries query per metric. Chunked at concurrency 4 inside runDqlChunks.
      // interval:1h instead of interval:1d — daily rollup undercounts raw ingested
      // datapoints by ~1000x; hourly reads from finer-grained data and matches billing
      const queries = top.map(
        (m) =>
          `timeseries dp = count(\`${m.metric_key}\`), from:now()-${HISTORY_DAYS}d, interval:1h
| fieldsAdd metric_key = "${m.metric_key}"`
      );
      const recs = await runDqlChunks(queries, 4);
      if (abort) return;

      const byKey = new Map<string, number[]>();
      for (const r of recs) {
        const key = r.metric_key as string;
        if (!key) continue;
        const hourly: number[] = (r.dp || []).map((v: any) => N(v));
        // Roll up 24 hourly buckets into each calendar day
        const daily: number[] = [];
        for (let i = 0; i < hourly.length; i += 24) {
          daily.push(hourly.slice(i, i + 24).reduce((a, b) => a + b, 0));
        }
        byKey.set(key, daily);
      }

      const out: MetricForecast[] = top.map((m) => {
        const history = byKey.get(m.metric_key) ?? [];
        const fc = linearForecast(history, HORIZON_DAYS);
        const total = history.reduce((a, b) => a + b, 0);
        const projected = fc.forecast.reduce((a, b) => a + b, 0);
        return {
          metric_key: m.metric_key,
          series: m.series,
          history: fc.history,
          forecast: fc.forecast,
          upper: fc.upper,
          lower: fc.lower,
          total,
          projected,
          slope: fc.slope,
          r2: fc.r2,
        };
      });
      setRows(out);
      setLoading(false);
    })();
    return () => { abort = true; };
  }, [topN]);

  const sorted = useMemo(() => {
    const r = [...rows];
    if (sortBy === "projected") r.sort((a, b) => b.projected - a.projected);
    else if (sortBy === "current") r.sort((a, b) => b.total - a.total);
    else if (sortBy === "growth") r.sort((a, b) => {
      const aAvg = a.history.length ? a.total / a.history.length : 1;
      const bAvg = b.history.length ? b.total / b.history.length : 1;
      const aG = aAvg > 0 ? a.slope / aAvg : 0;
      const bG = bAvg > 0 ? b.slope / bAvg : 0;
      return bG - aG;
    });
    return r;
  }, [rows, sortBy]);

  if (loading) return <Loader msg={progress} />;

  const totalCurrent = rows.reduce((a, b) => a + b.total, 0);
  const totalProjected = rows.reduce((a, b) => a + b.projected, 0);
  const growthPct = totalCurrent > 0 ? ((totalProjected - totalCurrent) / totalCurrent) * 100 : 0;
  const currentCost = costUSD(totalCurrent, rateCentsPerDp);
  const projectedCost = costUSD(totalProjected, rateCentsPerDp);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        <Stat label={`Top metrics analyzed`} value={String(rows.length)} sub={`Top ${topN} by series cardinality`} />
        <Stat label={`Datapoints (last ${HISTORY_DAYS}d)`} value={fmtNum(totalCurrent)} sub={`Cost: ${fmtUSD(currentCost)}`} />
        <Stat label={`Projected (next ${HORIZON_DAYS}d)`} value={fmtNum(totalProjected)} sub={`Cost: ${fmtUSD(projectedCost)}`} />
        <Stat label="Aggregate trend"
              value={`${growthPct >= 0 ? "+" : ""}${growthPct.toFixed(1)}%`}
              sub={`vs current ${HISTORY_DAYS}d total`} />
        <Stat label="Est. monthly cost" value={fmtUSD(currentCost)} sub={`Projected: ${fmtUSD(projectedCost)}/mo`} />
      </div>

      <Card>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontSize: 12, opacity: 0.7 }}>Sort by:</span>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as any)}
                  style={selStyle}>
            <option value="projected">Projected datapoints (next {HORIZON_DAYS}d)</option>
            <option value="current">Current datapoints (last {HISTORY_DAYS}d)</option>
            <option value="growth">Relative growth (slope / avg)</option>
          </select>
          <button onClick={() => downloadCsvForecastTopN(sorted, rateCentsPerDp)} style={btnSec}>
            Export CSV
          </button>
        </div>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(420px, 1fr))", gap: 12 }}>
        {sorted.map((m) => {
          const avg = m.history.length ? m.total / m.history.length : 0;
          const relGrowth = avg > 0 ? (m.slope / avg) * 100 : 0;
          return (
            <Card key={m.metric_key}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, gap: 8 }}>
                <code style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {m.metric_key}
                </code>
                <span style={{ fontSize: 11, opacity: 0.6, whiteSpace: "nowrap" }}>{fmtNum(m.series)} series</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 4, marginBottom: 6, fontSize: 11 }}>
                <div>
                  <div style={{ opacity: 0.65 }}>Last {HISTORY_DAYS}d</div>
                  <div style={{ fontWeight: 600 }}>{fmtNum(m.total)}</div>
                </div>
                <div>
                  <div style={{ opacity: 0.65 }}>Next {HORIZON_DAYS}d</div>
                  <div style={{ fontWeight: 600 }}>{fmtNum(m.projected)}</div>
                </div>
                <div>
                  <div style={{ opacity: 0.65 }}>$/month</div>
                  <div style={{ fontWeight: 600 }}>{fmtUSD(costUSD(m.total / (HISTORY_DAYS || 1), rateCentsPerDp) * 30)}</div>
                </div>
                <div>
                  <div style={{ opacity: 0.65 }}>Trend</div>
                  <div style={{
                    fontWeight: 600,
                    color: relGrowth > 5 ? "#ff6b35" : relGrowth < -5 ? "#10b981" : undefined,
                  }}>
                    {relGrowth >= 0 ? "+" : ""}{relGrowth.toFixed(1)}%/d
                  </div>
                </div>
              </div>
              <LineChart
                history={m.history}
                forecast={m.forecast}
                upper={m.upper}
                lower={m.lower}
                height={120}
              />
            </Card>
          );
        })}
      </div>

      <Card>
        <div style={{ fontSize: 11, opacity: 0.65 }}>
          Per-metric history uses <code>count(&lt;metric.key&gt;)</code> aggregated per day over {HISTORY_DAYS} days. Forecast is OLS linear regression with 95% prediction interval. Top N metrics are selected by current series cardinality (a strong proxy for ingest volume).
        </div>
      </Card>
    </div>
  );
};

function downloadCsvForecastTopN(rows: MetricForecast[], rate: number) {
  const header = ["metric_key", "series", "history_dp_30d", "projected_dp_30d", "monthly_cost_usd", "rel_growth_pct_per_day", "r2"];
  const lines = [header.join(",")];
  for (const m of rows) {
    const avg = m.history.length ? m.total / m.history.length : 0;
    const relGrowth = avg > 0 ? (m.slope / avg) * 100 : 0;
    const monthly = costUSD(m.total / (HISTORY_DAYS || 1), rate) * 30;
    lines.push([`"${m.metric_key}"`, m.series, m.total.toFixed(0), m.projected.toFixed(0), monthly.toFixed(6), relGrowth.toFixed(4), m.r2.toFixed(4)].join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `forecast-top-metrics-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const btnSec: React.CSSProperties = {
  padding: "6px 12px",
  background: "transparent",
  border: "1px solid rgba(128,128,128,0.4)",
  borderRadius: 4,
  color: "inherit",
  cursor: "pointer",
  fontSize: 12,
};

const selStyle: React.CSSProperties = {
  padding: "4px 8px",
  background: "rgba(128,128,128,0.1)",
  border: "1px solid rgba(128,128,128,0.3)",
  borderRadius: 4,
  color: "inherit",
};
