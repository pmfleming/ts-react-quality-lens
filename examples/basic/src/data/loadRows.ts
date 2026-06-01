export type Row = {
  id: string;
  label: string;
  amount: number;
};

export async function loadRows(): Promise<Row[]> {
  const text = localStorage.getItem("rows");
  if (!text) {
    return [];
  }
  return JSON.parse(text) as Row[];
}
