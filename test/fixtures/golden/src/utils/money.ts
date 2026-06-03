export function renderMoney(amount: number, unit: string): string {
  const rounded = Math.round(amount * 100) / 100;
  const prefix = unit === "USD" ? "$" : `${unit} `;
  return `${prefix}${rounded.toFixed(2)}`;
}
