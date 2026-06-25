import React, { useEffect, useMemo, useState } from "react";
import { Card, Stat, Loader } from "../components/Common";
import { LineChart } from "../components/LineChart";
import { BarList } from "../components/BarList";
import {
  fetchTotalIngestSeries,
  fetchTopSources,
  fetchByChannel,
  SourceRow,
  ChannelRow,
} from "../lib/queries";
import { fmtNum } from "../lib/forecast";
import { costUSD, fmtUSD } from "../lib/cost";
import { timeframeDays, intervalForTf } from "../lib/timeframe";
import { useSettings } from "../state/SettingsContext";

interface Props { timeframe: string; }

export const OverviewPage: React.FC<Props> = ({ timeframe }) => {
  const { rateCentsPerDp } = useSettings();
  const [loading, setLoading] = useState(true);
  const [series, setSeries] = useState<{ start: number; interval: number; values: number[] } | null>(null);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [channels, setChannels] = useState<ChannelRow[]>([]);

  const days = timeframeDays(timeframe);

  useEffect(() => {
    let abort = false;
    setLoading(true);
    // Fire all three independently so the chart can render as soon as the
    // primary timeseries arrives; sources/channels populate progressively.
    fetchTotalIngestSeries(timeframe, intervalForTf(timeframe)).then((s) => {
      if (abort) return;
      setSeries(s);
      setLoading(false);
    });
    fetchTopSources(timeframe).then((src) => { if (!abort) setSources(src); });
    fetchByChannel(timeframe).then((ch) => { if (!abort) setChannels(ch); });
    return () => { abort = true; };
  }, [timeframe]);

  const total = (series?.values || []).reduce((a, b) => a + b, 0);
  const totalCost = costUSD(total, rateCentsPerDp);
  const dailyAvgCost = totalCost / Math.max(1, days);
  const sourceTotal = sources.reduce((a, b) => a + b.total, 0);
  const channelTotal = channels.reduce((a, b) => a + b.total, 0);

  const sourceRows = useMemo(
    () => sources.slice(0, 15).map((s) => ({
      label: s.source, value: s.total,
      pct: sourceTotal > 0 ? (s.total / sourceTotal) * 100 : 0,
    })),
    [sources, sourceTotal],
  );
  const channelRows = useMemo(
    () => channels.map((c) => ({
      label: c.channel, value: c.total,
      pct: channelTotal > 0 ? (c.total / channelTotal) * 100 : 0,
    })),
    [channels, channelTotal],
  );

  if (loading) return <Loader msg="Loading metric ingest..." />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        <Stat label="Total ingested datapoints" value={fmtNum(total)} sub={`Cost: ${fmtUSD(totalCost)}`} />
        <Stat label="Est. monthly cost" value={fmtUSD(dailyAvgCost * 30)} sub={`${fmtUSD(dailyAvgCost * 365)}/yr (extrapolated)`} />
        <Stat label="Distinct ingest sources" value={String(sources.length)} />
        <Stat label="Distinct ingest channels" value={String(channels.length)} />
      </div>

      <Card title="Ingested datapoints over time">
        {series && series.values.length > 0 ? (
          <LineChart
            history={series.values}
            startMs={series.start}
            intervalMs={series.interval / 1e6}
            yLabel="datapoints / interval"
          />
        ) : <div style={{ opacity: 0.7 }}>No data.</div>}
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Card title="Top sources by ingested datapoints">
          <BarList rows={sourceRows} />
        </Card>
        <Card title="Datapoints by ingest channel">
          <BarList rows={channelRows} />
        </Card>
      </div>

      <Card>
        <div style={{ fontSize: 12, opacity: 0.7 }}>
          Source: <code>dt.sfm.server.metrics.ingest.external_datapoints</code> (actual ingested datapoints from custom/extension/OTLP sources, not OneAgent built-ins).
        </div>
      </Card>
    </div>
  );
};
