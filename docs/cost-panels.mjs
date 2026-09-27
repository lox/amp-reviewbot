// Run `node docs/cost-panels.mjs` to print importable Grafana panel JSON.
// Assign unique IDs and free grid positions when adding to an existing dashboard.
const datasource = { type: "prometheus", uid: "prometheus_on_fly" }
const metric = (name, period) => `max(reviewbot_cost_${name}_${period}{app="lox-amp-reviewbot"})`
// Fly's VictoriaMetrics drops NaN series. A display-only -1 fallback keeps unknown
// percentile/coverage fields visible; the value mapping renders it as an em dash.
const panels = []
function panel(title, description, series, unit, type = "stat") {
  const index = panels.length
  panels.push({
    id: 100 + index, title, description, type, datasource,
    gridPos: { x: index % 2 * 12, y: Math.floor(index / 2) * 8, w: 12, h: 8 },
    targets: series.map(([legendFormat, expr], i) => ({
      refId: String.fromCharCode(65 + i), datasource, expr, legendFormat,
      instant: type !== "timeseries", range: type === "timeseries",
    })),
    fieldConfig: { defaults: {
      unit, noValue: "—", decimals: unit === "currencyUSD" ? 3 : 0,
      mappings: [{ type: "value", options: { "-1": { text: "—" } } }],
    }, overrides: [] },
    options: type === "timeseries"
      ? { legend: { displayMode: "list", placement: "bottom" }, tooltip: { mode: "multi" } }
      : { reduceOptions: { calcs: ["lastNotNull"], values: false }, textMode: "value_and_name", colorMode: "none", graphMode: "none" },
  })
}
const caveat = "Costs attributed to completion time, including retries and failed/cancelled reviews. Recorded partial totals, not invoices. Amp usage and provider estimates must not be added. Fixed window, independent of the time picker."
for (const period of ["24h", "7d"]) {
  panel(`Recorded review cost · ${period}`, caveat, [
    ["Amp usage", metric("amp_usd", period)], ["Provider estimate", metric("provider_usd", period)],
  ], "currencyUSD")
  panel(`Cost per review · ${period}`, "Only reviews with at least one thread and every thread cost recorded for that measure. See coverage for sample counts; unknown is not zero.",
    ["amp", "provider"].flatMap(source => ["median", "p95"].map(stat =>
      [`${source} ${stat}`, `${metric(`${source}_${stat}_usd`, period)} or vector(-1)`])), "currencyUSD")
  panel(`Cost coverage · ${period}`, "Complete-review counts are percentile sample sizes. Denominator includes all finished reviews, including those without threads. Zero reviews means unknown coverage.", [
    ["Amp complete %", `(100 * ${metric("amp_complete_reviews", period)} / ${metric("reviews", period)}) or vector(-1)`],
    ["Provider complete %", `(100 * ${metric("provider_complete_reviews", period)} / ${metric("reviews", period)}) or vector(-1)`],
  ], "percent")
  panel(`Cost samples and gaps · ${period}`, "Thread counts and review counts are different units. Lookup errors remain missing until separately repaired; no historical backfill is performed by these panels.", [
    ["Finished reviews", metric("reviews", period)],
    ["Amp complete reviews", metric("amp_complete_reviews", period)],
    ["Provider complete reviews", metric("provider_complete_reviews", period)],
    ["Reviews without threads", metric("reviews_without_threads", period)],
    ["Pending threads", metric("pending_threads", period)],
    ["Error threads", metric("error_threads", period)],
  ], "short")
}
panel("Daily recorded cost · UTC", `${caveat} Each bar is a UTC completion-day bucket from the latest scrape, refreshed for late usage. Today is partial.`,
  ["amp", "provider"].map(source => [source,
    Array.from({ length: 7 }, (_, i) => {
      const day = 6 - i
      return `label_replace(${metric(`${source}_usd`, `day_${day}`)}, "day", "${day === 0 ? "0d ago (today)" : `${day}d ago`}", "", "")`
    }).join(" or ")]), "currencyUSD", "barchart")
const daily = panels.at(-1)
daily.gridPos.w = 24
daily.targets.forEach(target => { target.format = "table" })
daily.transformations = [
  { id: "organize", options: { excludeByName: { Time: true }, renameByName: { Value: "Amp USD", "Value #A": "Amp USD", "Value #B": "Provider estimate" } } },
  { id: "sortBy", options: { sort: [{ field: "day", desc: true }] } },
]
// Join the instant-query tables by the bounded day label before organizing columns.
daily.transformations.unshift({ id: "joinByField", options: { byField: "day", mode: "outer" } })
daily.options = { xField: "day", orientation: "vertical", stacking: "none", showValue: "auto", legend: { displayMode: "list", placement: "bottom" } }
panel("Recorded cost trend · rolling 24h", `${caveat} This is a rolling total, not a counter; never apply rate() or increase().`, [
  ["Amp usage", metric("amp_usd", "24h")], ["Provider estimate", metric("provider_usd", "24h")],
], "currencyUSD", "timeseries")
panels.at(-1).gridPos = { x: 0, y: daily.gridPos.y + 8, w: 24, h: 8 }
console.log(JSON.stringify(panels, null, 2))
