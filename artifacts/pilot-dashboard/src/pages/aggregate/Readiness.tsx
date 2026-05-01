import AggregateGroupedList from "./AggregateGroupedList";

export default function AggregateReadiness() {
  return (
    <AggregateGroupedList
      kind="readiness-summary"
      titleKey="aggregateReadinessTitle"
    />
  );
}
