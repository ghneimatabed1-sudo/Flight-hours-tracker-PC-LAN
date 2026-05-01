import AggregateGroupedList from "./AggregateGroupedList";

// Aggregator-mode currency rollup. The squadron currency table lives
// inside `pilots` rows (expiry_day, expiry_night, …), so we render
// the same `pilots` resource here — operators see one entry per pilot
// across every squadron they aggregate, grouped by squadron, with the
// expiry columns visible alongside the rest of the pilot record.
export default function AggregateCurrencies() {
  return (
    <AggregateGroupedList kind="pilots" titleKey="aggregateCurrenciesTitle" />
  );
}
