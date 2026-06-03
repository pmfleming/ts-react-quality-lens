import fs from "node:fs";

export function readSecret(): string {
  return fs.existsSync(".env") ? "secret" : "missing";
}
