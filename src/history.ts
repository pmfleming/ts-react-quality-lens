import childProcess from "node:child_process";
import { toPosix } from "./files.js";

export function gitChurn(config) {
  const result = new Map();
  try {
    const output = childProcess.execFileSync("git", ["log", "--name-only", "--format=%an"], {
      cwd: config.projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30000,
    });
    let author = "unknown";
    for (const line of output.split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (!/\.[cm]?[jt]sx?$/.test(line)) {
        author = line.trim();
        continue;
      }
      const current = result.get(toPosix(line)) ?? { commits: 0, contributors: 0, contributor_names: new Set() };
      current.commits += 1;
      current.contributor_names.add(author);
      current.contributors = current.contributor_names.size;
      result.set(toPosix(line), current);
    }
  } catch {
    return result;
  }
  for (const [key, value] of result) {
    result.set(key, {
      commits: value.commits,
      contributors: value.contributors,
    });
  }
  return result;
}
