import childProcess from "node:child_process";
import path from "node:path";
import { toPosix } from "./files.js";
import type { Config } from "./types.js";

type ChurnAccumulator = { commits: number; contributors: number; contributor_names: Set<string> };
type ChurnRecord = { commits: number; contributors: number };
type HistoryAccumulator = ChurnAccumulator & {
  defect_commits: number;
  cochange_partners: Map<string, number>;
};
type GitHistoryRecord = ChurnRecord & {
  defect_commits: number;
  cochange_partners: Array<{ file: string; commits: number }>;
};

export function gitHistory(config: Config): Map<string, GitHistoryRecord> {
  const result = new Map<string, HistoryAccumulator>();
  try {
    const scopedRoots = config.sourceRoots.map((root) => toPosix(path.relative(config.projectRoot, root))).filter(Boolean);
    const args = ["log", "--name-only", "--format=commit:%H%x1f%an%x1f%s", "--since=2 years ago"];
    if (scopedRoots.length) args.push("--", ...scopedRoots);
    const output = childProcess.execFileSync("git", args, {
      cwd: config.projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30000,
    });
    for (const commit of parseGitCommits(output)) addCommitHistory(result, commit);
  } catch {
    return new Map();
  }
  const compact = new Map<string, GitHistoryRecord>();
  for (const [key, value] of result) {
    compact.set(key, {
      commits: value.commits,
      contributors: value.contributors,
      defect_commits: value.defect_commits,
      cochange_partners: [...value.cochange_partners.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 10)
        .map(([file, commits]) => ({ file, commits })),
    });
  }
  return compact;
}

function addCommitHistory(
  result: Map<string, HistoryAccumulator>,
  commit: { author: string; subject: string; files: string[] },
): void {
  const files = commit.files.filter((file) => /\.[cm]?[jt]sx?$/.test(file));
  const isDefect = /\b(?:fix|bug|revert|hotfix|regression|defect)\b/i.test(commit.subject);
  for (const file of files) {
    const current = result.get(file) ?? {
      commits: 0,
      contributors: 0,
      contributor_names: new Set<string>(),
      defect_commits: 0,
      cochange_partners: new Map<string, number>(),
    };
    current.commits += 1;
    current.contributor_names.add(commit.author);
    current.contributors = current.contributor_names.size;
    if (isDefect) current.defect_commits += 1;
    for (const partner of files) {
      if (partner !== file) current.cochange_partners.set(partner, (current.cochange_partners.get(partner) ?? 0) + 1);
    }
    result.set(file, current);
  }
}

function parseGitCommits(output: string): Array<{ author: string; subject: string; files: string[] }> {
  const commits: Array<{ author: string; subject: string; files: string[] }> = [];
  let current: { author: string; subject: string; files: string[] } | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("commit:")) {
      if (current) commits.push(current);
      const [, author = "unknown", subject = ""] = line.slice("commit:".length).split("\x1f");
      current = { author, subject, files: [] };
    } else if (current && line.trim()) {
      current.files.push(toPosix(line.trim()));
    }
  }
  if (current) commits.push(current);
  return commits;
}
