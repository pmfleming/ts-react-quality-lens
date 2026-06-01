"use client";

import { readFileSync } from "node:fs";

export default function Page() {
  const label = process.env.NEXT_PUBLIC_LABEL ?? "Example";
  const text = readFileSync("package.json", "utf8");
  return <main>{label}: {text.length}</main>;
}
