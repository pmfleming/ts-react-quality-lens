import { useEffect, useMemo, useState } from "react";
import { formatTotal } from "./format";
import { loadRows } from "./data/loadRows";

export interface AppProps {
  title: string;
  rows?: Array<{ id: string; label: string; amount: number }>;
  compact?: boolean;
  highlighted?: boolean;
  loading?: boolean;
  onSelect?: (id: string) => void;
}

export function App(props: AppProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [remoteRows, setRemoteRows] = useState<any[]>([]);
  const rows = props.rows ?? remoteRows;

  useEffect(() => {
    let mounted = true;
    loadRows().then((value) => {
      if (mounted) {
        setRemoteRows(value as any[]);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  const total = useMemo(() => {
    return rows.reduce((sum, row) => {
      if (row.amount > 10 && props.highlighted) {
        return sum + row.amount * 2;
      }
      return sum + row.amount;
    }, 0);
  }, [rows, props.highlighted]);

  return (
    <section>
      <h1>{props.title}</h1>
      {props.loading ? <p>Loading</p> : null}
      <ul>
        {rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => {
                setSelected(row.id);
                props.onSelect?.(row.id);
              }}
            >
              {row.label} {formatTotal(row.amount)}
            </button>
          </li>
        ))}
      </ul>
      {selected && <output>{selected}</output>}
      <strong>{formatTotal(total)}</strong>
    </section>
  );
}
