import { useEffect, useState } from "react";

export function HookRisk({ enabled }: { enabled: boolean }) {
  const [count, setCount] = useState(0);

  if (enabled) {
    useEffect(() => {
      setCount((value) => value + 1);
    }, []);
  }

  return <span>{count}</span>;
}
