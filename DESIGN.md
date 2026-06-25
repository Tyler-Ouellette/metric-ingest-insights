# Metric Ingest Insights — Design Document

---

## Non-Strato Dependencies

This section catalogs every library and SDK that is **not** part of `@dynatrace/strato-components` or `@dynatrace/strato-components-preview`, documenting what it provides and exactly where it is used.

### React Core

| Package | Version | What it provides |
|---------|---------|-----------------|
| `react` | ^18.2.0 | JSX runtime, all hooks (`useState`, `useEffect`, `useMemo`, `useCallback`, `useContext`, `createContext`) |
| `react-dom` | ^18.2.0 | DOM renderer via `ReactDOM.createRoot()` |

**`react`** is imported in every `.tsx` file in the project.

**`react-dom`** is used in one role: `react-dom/client` → `ReactDOM.createRoot()` in **`main.tsx`** to bootstrap the React tree into the DOM.

---

### Dynatrace SDK (Non-Strato)

#### `@dynatrace-sdk/client-query` (^1.24.0)

Provides the `queryClient.queryExecute()` API — the low-level DQL query runner.

Used in **`src/lib/dql.ts`** via the `runDql()` and `runDqlChunks()` wrappers, which are in turn called by every query function in **`src/lib/queries.ts`** and directly within page components.

#### `@dynatrace-sdk/app-environment` (^1.1.4)

Provides `getEnvironmentUrl()` — returns the base URL of the connected Dynatrace environment.

Not used directly in any page component. Listed as a dependency for potential deep-link construction; currently unreferenced in source.

#### `@dynatrace-sdk/units` (^1.5.0)

Dynatrace unit formatting helpers.

Not imported in any source file. Safe to remove.

#### `@dynatrace-sdk/navigation` (^2.2.0)

Cross-app navigation SDK.

Not imported in any source file. Safe to remove.

#### `@dynatrace-sdk/client-notification-v2` (^1.0.0)

Notification API client.

Not imported in any source file. Safe to remove.

---

### Internationalization

| Package | Version | What it provides |
|---------|---------|-----------------|
| `react-intl` | ^10.1.5 | Internationalization primitives |

Not imported in any source file. The app uses no `IntlProvider`, `FormattedMessage`, or `useIntl` calls. Safe to remove.

---

### Unused Dependencies (in package.json, not imported)

| Package | Version | Notes |
|---------|---------|-------|
| `@dynatrace-sdk/app-environment` | ^1.1.4 | Imported in 0 files currently |
| `@dynatrace-sdk/units` | ^1.5.0 | Never imported |
| `@dynatrace-sdk/navigation` | ^2.2.0 | Never imported |
| `@dynatrace-sdk/client-notification-v2` | ^1.0.0 | Never imported |
| `react-intl` | ^10.1.5 | Never imported |

---

## App Overview

**Metric Ingest Insights** (`my.metric.ingest`, v0.13.0) is an unofficial Dynatrace SE tool for analyzing metric storage cost, ingest volume, cardinality, and forecasted spend. It targets tenants that want to understand which metrics are driving their DPS (datapoints) bill, find idle metrics, and simulate what-if cardinality reductions.

---

## Architecture

```
src/
├── main.tsx                        # ReactDOM.createRoot entry point
├── app/
│   └── App.tsx                     # SettingsProvider + Shell + tab router
├── pages/                          # One file per tab (10 pages)
│   ├── OverviewPage.tsx
│   ├── TopMetricsPage.tsx
│   ├── SourcesPage.tsx
│   ├── ForecastPage.tsx
│   ├── ForecastTopNPage.tsx
│   ├── CostForecastPage.tsx
│   ├── CostPage.tsx
│   ├── UsagePage.tsx
│   ├── DiffPage.tsx
│   └── OptimizePage.tsx
├── components/                     # Shared UI primitives
│   ├── Common.tsx                  # Card, Stat, Loader
│   ├── LineChart.tsx               # SVG line chart with forecast & CI band
│   ├── BarList.tsx                 # Horizontal bar chart
│   ├── SortableTable.tsx           # Sortable, resizable, sticky-header table
│   ├── SettingsModal.tsx           # topN / cost-rate / budget dialog
│   └── DisclaimerModal.tsx         # One-time unofficial-app warning
├── lib/
│   ├── dql.ts                      # runDql / runDqlChunks wrappers
│   ├── queries.ts                  # All DQL query functions + typed interfaces
│   ├── forecast.ts                 # OLS linear regression + fmtNum / fmtBytes
│   └── cost.ts                     # Cost rate constant + costUSD / fmtUSD
└── state/
    ├── SettingsContext.tsx          # React context: topN, rateCentsPerDp, monthlyBudgetUSD
    └── CostContext.tsx             # Legacy cost context (unused — not wired)
```

---

## Key Design Patterns

- **Chunked parallel queries**: `metric.series` has a per-query result-row cap. `fetchAllMetricCardinality` issues one DQL query per metric-key prefix (`dt.`, `a`–`z`, `0`–`9`, `_`) and runs them in parallel with concurrency=4 via `runDqlChunks`. Results are merged by deduplicated `metric.key`.
- **Hourly→daily rollup**: `fetchMetricDailyDatapoints` uses `interval:1h` instead of `interval:1d` because the daily rollup in `count(<metric>)` dramatically undercounts raw ingested datapoints. The 24 hourly values are then summed client-side into calendar days.
- **Client-side cost math**: All dollar amounts are computed in the browser as `datapoints × ratePerDpUSD`. No DQL cost query exists.
- **Client-side forecasting**: `dt.sfm.*` and `timeseries_predict` are not used for projection. OLS linear regression runs in the browser against historical daily values.
- **Settings context**: `topN`, `rateCentsPerDp`, and `monthlyBudgetUSD` are global React context values. Every cost-sensitive page reads from `useSettings()`.
- **Abort signals**: All `useEffect` data-fetch blocks pass `AbortController.signal` to async operations and call `abort()` on cleanup to prevent state updates after unmount.
- **Inline SVG charts**: `LineChart` and `BarList` render raw SVG with no external chart library. All layout math is inline.
- **CSS-in-JS**: All styles are inline `style={}` objects. No external CSS files.

---

## Global Controls

### Header Bar

A single unified header spanning all tabs:

| Control | What it does |
|---------|-------------|
| **App title** | "Metric Ingest Insights" heading |
| **Timeframe selector** | Dropdown sets `timeframe` prop passed to every page; options: 1h, 6h, 1d, 7d (default), 14d, 30d |
| **Settings gear** | Opens `SettingsModal`; tooltip shows current topN and rate |
| **Disclaimer modal** | Shown once on first launch (per app version) — amber warning that the app is unofficial |

### Settings (`SettingsModal`)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `topN` | 20 | Max metrics shown in top-N lists and forecast pages |
| `rateCentsPerDp` | `4.55e-7` USD/DP | Cost rate for all dollar estimates; $45.50 per 100M DPs |
| `monthlyBudgetUSD` | 0 (disabled) | Optional monthly spend cap; enables burn-down bar in Cost Forecast |

Settings are held in React state (not localStorage). They reset on page reload.

---

## Tab: Overview

### Purpose

Primary landing tab. Shows fleet-wide ingest totals, cost KPIs, a time-series chart of datapoint ingestion, and the top-10 breakdown by source and by ingest channel.

### DQL Queries

#### Total ingest time series
```dql
timeseries dp = sum(dt.sfm.server.metrics.ingest.external_datapoints),
  from:<timeframe>, interval:<auto>
```

Returned as a single row with a `dp` array (one value per interval bucket) and a `timeframe` object containing `start` and `interval` (nanoseconds). The app converts interval to milliseconds for the x-axis.

#### Top sources
```dql
timeseries dp = sum(dt.sfm.server.metrics.ingest.external_datapoints),
  by:{source}, from:<timeframe>
| fieldsAdd total = arraySum(dp)
| fields source, total
| sort total desc
```

#### Ingest by channel
```dql
timeseries dp = sum(dt.sfm.server.metrics.ingest.external_datapoints),
  by:{dt.ingest.channel}, from:<timeframe>
| fieldsAdd total = arraySum(dp)
| fields channel = dt.ingest.channel, total
| sort total desc
```

### Logic

The `BarList` component renders the top-10 source and channel rows. Total DPs are multiplied by `rateCentsPerDp` via `costUSD()` to show estimated cost alongside raw datapoint counts.

---

## Tab: Top Metrics

### Purpose

Lists all metric keys in the tenant ordered by series cardinality (number of distinct dimension combinations). Clicking a row opens a detail panel with a 30-day daily datapoint history, a 14-day linear forecast, and a per-source series breakdown.

### DQL Queries

#### All-metric cardinality (chunked)
```dql
-- Repeated for each prefix in PREFIXES (38 total):
fetch metric.series, from:<timeframe>
| filter startsWith(metric.key, "<prefix>")
| summarize series = count(), by:{metric.key}
```

The prefix list: `"dt."`, then `a`–`z`, `0`–`9`, `_`. Queries run 4 at a time; results merge by `metric.key` (keeping the max series count for any key seen in multiple buckets).

#### Per-metric daily datapoints (detail panel)
```dql
timeseries dp = count(<metric_key>), from:now()-30d, interval:1h
```

24 hourly buckets are summed client-side into each calendar day.

#### Per-metric source breakdown (detail panel)
```dql
fetch metric.series, from:<timeframe>
| filter metric.key == "<metric_key>"
| summarize s = count(), by:{dt.metrics.source}
| sort s desc
```

### Logic

- `estDailyDatapoints` = `series × 1440` (heuristic: assumes 1-minute ingest cadence)
- The detail panel forecasts using `linearForecast(dailyValues, 14)` and renders via `LineChart` with a dashed forecast section and 95% confidence band
- `SortableTable` renders the metric list with sortable columns; clicking a row expands the detail panel inline

---

## Tab: Cost

### Purpose

Detailed cost-analysis table: every metric key annotated with its estimated daily and annual cost. Supports text-prefix filtering (useful for isolating metrics owned by a team or extension) and CSV export.

### DQL Queries

Same as Top Metrics: `fetchAllMetricCardinality` (chunked `metric.series` queries).

### Logic

- Daily cost per metric = `estDailyDatapoints × rateCentsPerDp`
- Annual cost = daily × 365
- Prefix filter (`filter` input) applies a `startsWith(metric_key, input)` check client-side
- CSV export serializes the filtered rows with columns: metric_key, series, estDailyDatapoints, dailyCostUSD, annualCostUSD

---

## Tab: Sources

### Purpose

Shows the top 50 ingest sources by total datapoints over the selected timeframe. Clicking a source opens a time-series chart with a 14-day forecast.

### DQL Queries

#### Top sources with time series (for forecast)
```dql
timeseries dp = sum(dt.sfm.server.metrics.ingest.external_datapoints),
  by:{source}, from:<timeframe>, interval:<auto>
| fieldsAdd total = arraySum(dp)
| sort total desc
| limit <topN>
```

### Logic

`BarList` renders the top-50 sources. Clicking a row renders a `LineChart` with `linearForecast(values, 14)`.

---

## Tab: Idle Metrics

### Purpose

Cross-references ingested metric keys against DQL query execution history to flag metrics that are **never queried**. Each metric is badged IDLE, RARE (1–2 executions in 30d), or ACTIVE.

### DQL Queries

#### Metric cardinality
Same `fetchAllMetricCardinality` chunked query as Top Metrics.

#### Query execution history
```dql
fetch dt.system.events, from:now()-30d
| filter event.kind == "QUERY_EXECUTION_EVENT"
    and table == "metrics"
    and isNotNull(query_string)
| summarize cnt = count(), by:{query_string}
```

Returns up to 100,000 rows. The `query_string` column holds the raw DQL text of each executed query.

### Logic

For each `MetricKeyRow`, the page checks how many of the returned query strings mention the `metric_key` as a substring (simple `includes()` check). A metric is:
- **ACTIVE**: mentioned in ≥ 3 query strings
- **RARE**: mentioned in 1–2 query strings
- **IDLE**: not mentioned in any query string

The page shows total annual cost of all IDLE metrics as a headline saving opportunity.

---

## Tab: Weekly Diff

### Purpose

Compares metric cardinality now vs a historical snapshot (7d / 14d / 30d ago). Surfaces which metrics are **new**, **gone**, **grew**, or **shrank** in series count.

### DQL Queries

Two parallel calls to `fetchAllMetricCardinality` with different timeframes:
- Current: `from:now()-2h`
- Historical: `from:now()-<window>d` to `to:now()-<window>d+2h`

### Logic

The two maps are joined by `metric.key`:

| Status | Condition |
|--------|-----------|
| New | Present in current, absent in historical |
| Gone | Absent in current, present in historical |
| Grew | `current.series > historical.series` |
| Shrank | `current.series < historical.series` |
| Unchanged | Equal series count |

`delta = current.series - historical.series`
`pctChange = delta / historical.series × 100`

`costDelta = (delta × 1440) × rateCentsPerDp` — estimated daily cost change.

---

## Tab: Forecast Overall

### Purpose

Projects total metric ingest (all metrics combined) forward using configurable history and horizon windows. Displays the OLS regression line with a 95% prediction interval band.

### DQL Queries

```dql
timeseries dp = sum(dt.sfm.server.metrics.ingest.external_datapoints),
  from:now()-<historyDays>d, interval:1d
```

The daily values are extracted from the `dp` array.

### Logic

- History window: 14–90 days (user-configurable slider)
- Forecast horizon: 7–90 days (user-configurable slider)
- `linearForecast(dailyValues, horizon)` computes slope, intercept, R², and ±1.96σ prediction band
- `LineChart` renders historical (solid) and forecast (dashed) with CI shading
- Slope converted to "daily change rate" and shown as a KPI

---

## Tab: Forecast Top N Metrics

### Purpose

Runs an individual OLS forecast for each of the top N metric keys (by cardinality) and ranks them by projected daily growth rate (% per day).

### DQL Queries

For each of the top-N metric keys from `fetchAllMetricCardinality`:
```dql
timeseries dp = count(<metric_key>), from:now()-30d, interval:1h
```

Hourly values are rolled to daily before forecasting. All N queries run in parallel.

### Logic

`growth = slope / mean(history) × 100` — relative daily growth as a percentage. Metrics are sorted by growth descending. A `SortableTable` shows metric key, current series, daily growth %, and R².

---

## Tab: Cost Forecast

### Purpose

Budget-focused view. Shows projected monthly spend, a burn-down bar if a monthly budget is configured, a "days until budget exceeded" countdown, and per-metric cost forecasts for the top N metrics.

### DQL Queries

Same as Forecast Top N: `fetchAllMetricCardinality` plus per-metric hourly timeseries for the top N keys.

### Logic

- Monthly projected spend = `slope_per_day × 30 × rateCentsPerDp` summed across all top-N metrics
- **Burn-down bar**: `(projectedMonthlySpend / monthlyBudgetUSD) × 100%` — shown only when `monthlyBudgetUSD > 0`
- **Days until budget exceeded**: `monthlyBudgetUSD / dailySpendRate` — uses current daily spend, not projected slope
- Each metric card shows current estimated daily cost and forecasted growth

---

## Tab: Optimize

### Purpose

Dimension cardinality explorer with a what-if simulator. Shows which dimension fields on a metric are driving its series explosion and estimates how many series (and dollars) would be saved by removing a dimension.

### DQL Queries

#### All series for a specific metric key
```dql
fetch metric.series, from:<timeframe>
| filter metric.key == "<metric_key>"
```

Returns up to 100,000 rows; each row is one series record with all dimension fields inline.

### Logic

For each field (column) present across the series records:
- `distinct`: number of unique values for that field
- `fillRate`: fraction of series that have a non-null value for the field
- `topValues`: most common values (up to 5)

`DimStat` objects are rendered in a table. The what-if simulator computes:

`estimated_series_after_drop = total_series / distinct_values_for_dropped_dimension`

This is a coarse estimate assuming uniform distribution of the dropped dimension. Estimated daily datapoint savings and dollar savings are shown immediately.

---

## Shared Components

### `Common.tsx`

| Export | Purpose |
|--------|---------|
| `Card` | Styled container with rounded corners, subtle background |
| `Stat` | KPI display: large value + label + optional sub-label |
| `Loader` | Centered spinner for loading states |

### `LineChart.tsx`

Lightweight inline SVG chart. Props:

| Prop | Type | Purpose |
|------|------|---------|
| `history` | `number[]` | Historical data series (solid line) |
| `forecast` | `number[]?` | Forecast values (dashed line extension) |
| `upper` / `lower` | `number[]?` | 95% CI bounds (shaded polygon) |
| `labels` | `string[]?` | X-axis tick labels |
| `height` | `number` | SVG height (default 180) |
| `color` | `string` | Line color |

The chart auto-scales the Y-axis from `min(all values)` to `max(all values)` with 10% padding. The CI band is rendered as a polygon with 15% opacity. A vertical dashed line separates historical from forecast.

### `BarList.tsx`

Horizontal bar chart for top-N breakdowns. Each bar is a `<div>` with percentage width, label on the left, and value (+ optional cost) on the right. Supports a custom `format` callback for the value label.

### `SortableTable.tsx`

Full-featured data table:
- Click column header to sort ascending; click again for descending
- Drag column divider to resize (mouse down on resize handle)
- Sticky header (`position: sticky; top: 0`)
- Optional `onRowClick` handler
- `maxRows` prop with "showing X of Y" overflow indicator
- CSV export available via `exportCSV(rows, columns)` utility

### `SettingsModal.tsx`

Dark overlay modal (full-screen backdrop). Three inputs:
- **Top N** (number input, 1–200): controls `topN` in `SettingsContext`
- **Cost per DP** (number input, scientific notation supported): controls `rateCentsPerDp`
- **Monthly Budget USD** (number input, 0 = disabled): controls `monthlyBudgetUSD`

Changes apply immediately (controlled inputs wired to context setters). Close button dismisses without a separate "save."

### `DisclaimerModal.tsx`

Amber-bordered warning modal shown once per app version (tracked by version string in `sessionStorage`). States the app is unofficial community software. Includes a link to the GitHub repo and a dismiss button.

---

## Forecasting Engine (`src/lib/forecast.ts`)

### `linearForecast(history, horizon)`

Ordinary Least Squares linear regression. Input: array of evenly-spaced historical values. Output: `ForecastResult`.

```
xs = [0, 1, 2, ..., n-1]
slope = Σ((xi - x̄)(yi - ȳ)) / Σ((xi - x̄)²)
intercept = ȳ - slope × x̄
R² = 1 - SSres / SStot
σ = sqrt(SSres / (n - 2))
```

For each forecast step `h = 1..horizon`:
```
x = n - 1 + h
ŷ = slope × x + intercept
band = 1.96 × σ × sqrt(1 + 1/n + (x - x̄)² / Σ(xi - x̄)²)
upper = max(0, ŷ + band)
lower = max(0, ŷ - band)
```

All forecast and band values are clamped to ≥ 0 (datapoints cannot be negative).

### Formatting Helpers

| Function | Output examples |
|----------|----------------|
| `fmtNum(n)` | `1.23K`, `45.67M`, `1.23B`, `9.87T` |
| `fmtBytes(n)` | `1.23 KB`, `456.78 MB`, `1.23 TB` |

---

## Cost Calculation (`src/lib/cost.ts`)

| Constant / Function | Value / Signature |
|--------------------|------------------|
| `DEFAULT_RATE_USD_PER_DP` | `4.55e-7` ($45.50 per 100M DPs) |
| `costUSD(datapoints, rate)` | `datapoints × rate` |
| `fmtUSD(v)` | `$1.23K`, `$4.56M`, `$0.0034`, `0.34¢`, `1.23e-4¢` |

`fmtUSD` uses graduated formatting: B/M/K for large values, fixed decimals for sub-dollar, cents notation for sub-cent values.

`DEFAULT_RATE_CENTS_PER_DP` is an alias for `DEFAULT_RATE_USD_PER_DP` kept for backward compatibility with early code that named the constant poorly.

---

## DQL Execution Layer (`src/lib/dql.ts`)

### `runDql(query, options?)`

Wraps `queryClient.queryExecute()`. Returns a typed `Record<string, unknown>[]`. Handles pagination (follows `nextPageKey` until exhausted). Accepts an optional `maxRecords` cap (default 10,000; set to 100,000 for full-series fetches).

### `runDqlChunks(queries, concurrency)`

Runs an array of DQL queries with a concurrency limit. Returns the flat-merged array of all records. Used by `fetchAllMetricCardinality` to run 38 prefix-queries 4 at a time without overwhelming the API.

### `N(value)`

Coerces a DQL record field to a `number`. Returns `0` for `null`, `undefined`, or non-numeric values. Used throughout `queries.ts` to safely extract numeric columns.

---

## Data Flow

```
User selects timeframe
       ↓
Shell (App.tsx) passes timeframe prop to active page
       ↓
Page useEffect → queries.ts function(s) → dql.ts runDql / runDqlChunks
       ↓
DQL results → typed interfaces (MetricKeyRow, SourceRow, etc.)
       ↓
Client-side transform (cost calc, forecast, rollup, diff)
       ↓
SortableTable / LineChart / BarList / Stat cards
```

Settings (topN, rate, budget) flow via `SettingsContext` and are consumed directly by any page that needs them — no prop threading.

---

## Scopes Required (`app.config.json`)

| Scope | Purpose |
|-------|---------|
| `storage:metrics:read` | `fetch metric.series`, `timeseries count(<metric>)`, `timeseries dt.sfm.*` |
| `storage:entities:read` | Entity name resolution in metric source lookups |
| `storage:buckets:read` | Named bucket queries (reserved for future use) |
| `storage:system:read` | `fetch dt.system.events` for query execution history (Idle Metrics tab) |

---

## Build & Deploy

```bash
npm install --legacy-peer-deps   # peer dep conflicts between strato versions require this flag
npx dt-app analyze               # validate app.config.json + bundle
npx dt-app deploy                # upload to the environment configured in app.config.json
```

Build tooling: `dt-app` CLI (^1.7.0), TypeScript 5.3, no bundler config needed beyond `app.config.json`.

---

## Known Limitations

| Limitation | Root cause | Mitigation |
|------------|-----------|------------|
| `metric.series` row cap | DQL per-query result limit | 38-prefix chunked queries in parallel |
| Daily rollup undercounting | `interval:1d` on `count()` aggregates at coarse granularity | Use `interval:1h` + client-side daily rollup |
| Forecast model is linear only | No `timeseries_predict` DQL function available | OLS in browser; adequate for trend indication, conservative for seasonal data |
| Settings not persisted | No `useUserAppState` hook used | Settings reset on page reload; add `useUserAppState` if persistence needed |
| Idle metric detection is heuristic | `query_string` substring match, not AST parse | False positives if a metric key is a substring of another key's name |
| Series estimate uses 1440×/day heuristic | Actual ingest cadence unknown from series table | `fetchMetricDailyDatapoints` gives true count when clicked in detail panel |
