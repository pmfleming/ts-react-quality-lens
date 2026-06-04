import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function packageRootFrom(importMetaUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), "..", "..");
}

export function packageJsonUrl(root: string): string {
  return pathToFileURL(path.join(root, "package.json")).href;
}
