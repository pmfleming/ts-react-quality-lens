import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Node 20 does not expand quoted test globs; enumerate identically on every platform.
const directory = path.resolve("dist/test");
const files = fs.readdirSync(directory).filter((name) => name.endsWith(".test.js")).sort().map((name) => path.join(directory, name));
if (!files.length) throw new Error("No compiled tests found");
const result = childProcess.spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
