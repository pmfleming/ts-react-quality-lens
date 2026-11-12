import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAnalysisContext } from "../src/analysis-context.js";
import { loadConfig } from "../src/config.js";
import { artifactNames, artifactText, databaseFile, openDatabase, textColumn, withStore } from "../src/store.js";

const storeUrl = new URL("../src/store.js", import.meta.url).href;
function child(directory: string, body: string) {
  const process = spawn(globalThis.process.execPath, ["--input-type=module", "-e", `
    import { openDatabase, databaseFile, transaction, newGeneration, putArtifact, pruneGenerations } from ${JSON.stringify(storeUrl)};
    const db = openDatabase(databaseFile(process.argv[1]));
    ${body}
  `, directory], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  process.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const done = once(process, "exit").then(([code, signal]) => ({ code, signal, stderr }));
  return { process, done };
}

// Exercise the actual native engine across processes, including initialization races.
test("local Turso serializes concurrent writers without losing generations or findings", { timeout: 20000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lens-turso-writers-"));
  const children = [0, 1, 2].map((writer) => child(directory, `
    for (let i = 0; i < 12; i++) transaction(db, () => {
      putArtifact(db, '${writer}-' + i + '.json', { records: [{ id: 'finding-${writer}-' + i }] }, newGeneration(db));
      pruneGenerations(db);
    });
    db.close();
  `));
  try {
    for (const result of await Promise.all(children.map(({ done }) => done))) assert.equal(result.code, 0, result.stderr);
    withStore(directory, (db) => {
      assert.equal(artifactNames(db).length, 36);
      assert.equal(db.prepare("SELECT count(*) AS n FROM findings").get().n, 36);
      assert.equal(db.prepare("SELECT count(*) AS n FROM generations").get().n, 36);
      const plan = db.prepare("EXPLAIN QUERY PLAN SELECT artifact FROM findings WHERE id = ?").all("finding-0-1");
      assert.match(JSON.stringify(plan), /findings_id/);
    });
  } finally {
    for (const { process } of children) process.kill();
    await Promise.all(children.map(({ done }) => done));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("readers see committed evidence during writes and recover after an abruptly killed writer", { timeout: 20000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lens-turso-crash-"));
  const seed = openDatabase(databaseFile(directory));
  seed.exec("INSERT INTO generations VALUES ('old', 'now'); INSERT INTO artifacts VALUES ('probe.json', 'old', 'previous')");
  seed.close();
  const worker = child(directory, `
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE artifacts SET payload = ?').run('uncommitted');
    process.stdout.write('ready');
    process.stdin.resume();
  `);
  try {
    await Promise.race([once(worker.process.stdout, "data"), worker.done.then((result) => { throw new Error(result.stderr); })]);
    assert.equal(withStore(directory, (db) => artifactText(db, "probe.json")), "previous");
    worker.process.kill("SIGKILL");
    await worker.done;
    withStore(directory, (db) => {
      assert.equal(artifactText(db, "probe.json"), "previous");
      db.prepare("UPDATE artifacts SET payload = ?").run("recovered");
      assert.equal(artifactText(db, "probe.json"), "recovered");
    });
    assert.equal(fs.existsSync(path.join(directory, ".publication-incomplete")), false);
  } finally {
    worker.process.kill("SIGKILL");
    await worker.done;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("unknown database versions fail closed instead of resetting evidence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lens-turso-version-"));
  try {
    withStore(directory, (db) => db.exec("PRAGMA user_version = 99"));
    assert.throws(() => openDatabase(databaseFile(directory)), /Unsupported lens database version/);
    assert.equal(textColumn({ payload: 3 }, "payload"), null);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("cache misses read metadata without loading the previous analysis payload", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lens-turso-cache-"));
  try {
    fs.mkdirSync(path.join(directory, "src"));
    const file = path.join(directory, "src/index.ts");
    fs.writeFileSync(file, "export const value = 1;\n");
    const config = loadConfig(path.join(directory, "lens.json"));
    assert.equal(createAnalysisContext(config).project().cache.status, "miss");
    withStore(config.cache.dir, (db) => {
      const prepare = db.prepare.bind(db);
      let payloadReads = 0;
      const mock = t.mock.method(db, "prepare", (sql: string) => {
        if (sql.startsWith("SELECT payload FROM analysis_cache")) payloadReads++;
        return prepare(sql);
      });
      try {
        assert.equal(createAnalysisContext(config).project().cache.status, "hit");
        assert.equal(payloadReads, 1);
        payloadReads = 0;
        fs.writeFileSync(file, "export const value = 2;\n");
        assert.equal(createAnalysisContext(config).project().cache.status, "miss");
        assert.equal(payloadReads, 0);
      } finally { mock.mock.restore(); }
    });
    config.cache.enabled = false;
    fs.rmSync(config.cache.dir, { recursive: true });
    assert.equal(createAnalysisContext(config).project().cache.status, "disabled");
    assert.equal(fs.existsSync(config.cache.dir), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
