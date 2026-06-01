export function summarizeInvoiceB(rows: Array<{ label: string; amount: number }>) {
  const visible = rows.filter((row) => row.amount > 0);
  const total = visible.reduce((sum, row) => sum + row.amount, 0);
  const labels = visible.map((row) => row.label.trim()).filter(Boolean);
  const average = visible.length === 0 ? 0 : total / visible.length;
  return {
    total,
    labels,
    average,
    formatted: `$${total.toFixed(2)}`,
  };
}
