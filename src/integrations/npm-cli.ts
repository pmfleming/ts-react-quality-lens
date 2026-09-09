import fs from "node:fs";
import path from "node:path";

/** Resolve npm's JavaScript entrypoint without executing platform-specific shims. */
export function resolveNpmCli(execPath = process.execPath, env: NodeJS.ProcessEnv = process.env): string {
  const npmExecPath = env.npm_execpath;
  if (npmExecPath && path.basename(npmExecPath) === "npm-cli.js" && isFile(npmExecPath)) {
    return npmExecPath;
  }

  const nodeDirectory = path.dirname(execPath);
  const candidates = npmCliCandidates(nodeDirectory);
  // Windows environment keys are case-insensitive, but plain environment objects aren't.
  const searchPath = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    for (const name of ["npm", "npm.cmd"]) {
      try {
        const executable = fs.realpathSync(path.join(directory, name));
        if (path.basename(executable) === "npm-cli.js") candidates.push(executable);
        candidates.push(...npmCliCandidates(path.dirname(executable)));
      } catch {
        // npm need not be installed in every PATH directory.
      }
    }
  }
  const cli = candidates.find(isFile);
  if (!cli) throw new Error("npm JavaScript CLI (npm-cli.js) was not found; install npm or add it to PATH");
  return cli;
}

function npmCliCandidates(directory: string): string[] {
  return [
    path.join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
}

function isFile(filename: string): boolean {
  try {
    return fs.statSync(filename).isFile();
  } catch {
    return false;
  }
}
