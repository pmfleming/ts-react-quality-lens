/** Accuracy only on explicitly labeled cases. Abstention never counts as a true negative. */
export type LabeledObservation = {
  id: string; rule: string; partition: "development" | "holdout"; expected: boolean; observed: boolean | null;
};

export function evaluateLabels(cases: LabeledObservation[]) {
  const ids = new Set<string>();
  for (const item of cases) {
    if (!item.id || ids.has(item.id)) throw new Error(`Duplicate or empty calibration case: ${item.id}`);
    ids.add(item.id);
  }
  const ratio = (a: number, b: number) => b ? a / b : null;
  return [...new Set(cases.map((item) => `${item.partition}\0${item.rule}`))].sort().map((key) => {
    const group = cases.filter((item) => `${item.partition}\0${item.rule}` === key);
    const tp = group.filter((item) => item.expected && item.observed === true).length;
    const fp = group.filter((item) => !item.expected && item.observed === true).length;
    const fn = group.filter((item) => item.expected && item.observed !== true).length;
    const tn = group.filter((item) => !item.expected && item.observed === false).length;
    const abstained = group.filter((item) => item.observed === null).length;
    const first = group[0];
    if (!first) throw new Error("Empty calibration group");
    return { partition: first.partition, rule: first.rule, labels: group.length,
      true_positives: tp, false_positives: fp, false_negatives: fn, true_negatives: tn, abstained,
      precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn),
      evaluation_coverage: ratio(group.length - abstained, group.length), abstention_rate: ratio(abstained, group.length) };
  });
}
