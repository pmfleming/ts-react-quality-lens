import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "@tursodatabase/database/compat";
import { isRecord } from "./collections.js";
import { artifactFindings } from "./findings.js";
import type { Config } from "./types.js";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS generations (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS artifacts (name TEXT PRIMARY KEY, generation TEXT NOT NULL, payload TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS artifacts_generation ON artifacts(generation);
  CREATE TABLE IF NOT EXISTS findings (artifact TEXT NOT NULL, ordinal INTEGER NOT NULL, id TEXT NOT NULL,
    rule_id TEXT, file TEXT, PRIMARY KEY (artifact, ordinal));
  CREATE INDEX IF NOT EXISTS findings_id ON findings(id);
  CREATE INDEX IF NOT EXISTS findings_rule_file ON findings(rule_id, file);
  CREATE TABLE IF NOT EXISTS analysis_cache (slot INTEGER PRIMARY KEY, cache_key TEXT NOT NULL,
    inputs TEXT NOT NULL, queries TEXT NOT NULL, payload TEXT NOT NULL);
`;
const sessions = new Map<string, Database>();

/**
 * Turso's experimental multiprocess WAL is unavailable on the Windows IO backend. Without it the engine
 * holds an exclusive per-process file lock, so overlapping processes serialize through the open retry
 * instead of reading concurrently; a lock held past the retry deadline fails closed.
 */
export function multiprocessWalSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

export function databaseFile(directory: string): string {
  return path.join(directory, "lens.db");
}

/** The engine coordinates CLI processes and editor workers through its local WAL. */
export function openDatabase(file: string): Database {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = connectLocal(file);
  try {
    const version = sqlGet(db, "PRAGMA user_version");
    if (!isRecord(version) || (version.user_version !== 0 && version.user_version !== 1)) throw new Error("Unsupported lens database version");
    if (version.user_version === 0) transaction(db, () => { db.exec(SCHEMA); db.exec("PRAGMA user_version = 1"); });
    return db;
  } catch (error) { db.close(); throw error; }
}

function connectLocal(file: string): Database {
  const deadline = Date.now() + 5000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { return new Database(file, { timeout: 5000, experimental: file === ":memory:" || !multiprocessWalSupported() ? [] : ["multiprocess_wal"] }); }
    catch (error) {
      // Turso briefly takes an exclusive file lock during open/initialization; its SQL timeout does not cover this.
      if (!(error instanceof Error) || !error.message.includes("Locking error:") || Date.now() >= deadline) throw error;
      Atomics.wait(wait, 0, 0, 10);
    }
  }
}

export function transaction<T>(db: Database, run: () => T, write = true): T {
  db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const value = run();
    db.exec("COMMIT");
    return value;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

/** Connections live only for a synchronous operation; nested readers share its snapshot. */
export function withStore<T>(directory: string, run: (db: Database) => T): T {
  const key = path.resolve(directory);
  const active = sessions.get(key);
  if (active) return run(active);
  const db = openDatabase(databaseFile(key));
  return usingStore(key, db, run);
}

export function usingStore<T>(directory: string, db: Database, run: (db: Database) => T): T {
  const key = path.resolve(directory);
  if (sessions.has(key)) { db.close(); throw new Error("Evidence publication is already active"); }
  sessions.set(key, db);
  try { return run(db); }
  finally { sessions.delete(key); db.close(); }
}

export function textColumn(row: unknown, column: string): string | null {
  return isRecord(row) && typeof row[column] === "string" ? row[column] : null;
}

export function artifactText(db: Database, name: string): string | null {
  return textColumn(sqlGet(db, "SELECT payload FROM artifacts WHERE name = ?", name), "payload");
}

export function artifactNames(db: Database): string[] {
  return sqlAll(db, "SELECT name FROM artifacts ORDER BY name").flatMap((row: unknown) => {
    const name = textColumn(row, "name");
    return name === null ? [] : [name];
  });
}

export function newGeneration(db: Database): string {
  const id = randomUUID();
  sqlRun(db, "INSERT INTO generations VALUES (?, ?)", id, new Date().toISOString());
  return id;
}

export function putArtifact(db: Database, name: string, value: unknown, generation: string): void {
  sqlRun(db, "INSERT INTO artifacts VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET generation = excluded.generation, payload = excluded.payload",
    name, generation, JSON.stringify(value));
  sqlRun(db, "DELETE FROM findings WHERE artifact = ?", name);
  const insert = db.prepare("INSERT INTO findings VALUES (?, ?, ?, ?, ?)");
  try {
    artifactFindings(value).forEach((finding, ordinal) => insert.run(name, ordinal, finding.id,
      typeof finding.rule_id === "string" ? finding.rule_id : null, typeof finding.file === "string" ? finding.file : null));
  } finally { insert.close(); }
}

/** Retain current evidence only; overwritten generations must not grow the working store forever. */
export function pruneGenerations(db: Database): void {
  db.exec("DELETE FROM generations WHERE id NOT IN (SELECT generation FROM artifacts)");
}

export function findingArtifacts(config: Config, id: string): string[] {
  return withStore(config.outputDir, (db) => sqlAll(db, "SELECT DISTINCT artifact FROM findings WHERE id = ? ORDER BY artifact", id)
    .flatMap((row: unknown) => { const name = textColumn(row, "artifact"); return name === null ? [] : [name]; }));
}

type Binding = string | number | null;
type Statement = ReturnType<Database["prepare"]>;
function prepared<T>(db: Database, sql: string, run: (statement: Statement) => T): T {
  const statement = db.prepare(sql);
  try { return run(statement); }
  finally { statement.close(); }
}

export function sqlGet(db: Database, sql: string, ...args: Binding[]): unknown {
  return prepared(db, sql, (statement): unknown => statement.get(...args));
}
export function sqlAll(db: Database, sql: string, ...args: Binding[]): unknown[] {
  return prepared(db, sql, (statement): unknown[] => statement.all(...args));
}
export function sqlRun(db: Database, sql: string, ...args: Binding[]): void {
  prepared(db, sql, (statement) => { statement.run(...args); });
}
