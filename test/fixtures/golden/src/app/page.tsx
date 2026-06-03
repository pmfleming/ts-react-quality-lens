"use client";

import { formatMoney } from "@lib/math";
import { readSecret } from "@server/secret";

export function Page() {
  return <img src={formatMoney(readSecret().length, "USD")} />;
}
