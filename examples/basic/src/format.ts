export function formatTotal(value: number) {
  if (value > 1000) {
    return `$${Math.round(value / 100) / 10}k`;
  }
  return `$${value.toFixed(2)}`;
}

export function formatPercent(value: number) {
  if (value > 1) {
    return `${Math.round(value)}%`;
  }
  return `${Math.round(value * 100)}%`;
}
