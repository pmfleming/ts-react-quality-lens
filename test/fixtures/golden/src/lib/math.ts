export function formatMoney(value: number, currency: string): string {
  const rounded = Math.round(value * 100) / 100;
  const prefix = currency === "USD" ? "$" : `${currency} `;
  return `${prefix}${rounded.toFixed(2)}`;
}

export function unusedPublicHelper(value: number): number {
  return value * 2;
}
