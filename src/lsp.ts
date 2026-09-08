import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { isSuppressed } from "./actions.js";
import { isRecord, isUnknownArray, parseJson } from "./collections.js";
import { loadConfig } from "./config.js";
import { suppressionEdit } from "./lsp-actions.js";
import type { Config, ScoredRecord } from "./types.js";

type LspRequest = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
type Notify = (method: string, params: unknown) => void;
type Measure = (config: Config) => Promise<ScoredRecord[]>;
const NO_RESPONSE = Symbol("no-response");

export function runLspServer(config: Config): void {
  let buffer = Buffer.alloc(0);
  const session = createLspSession(config);
  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString("utf8"));
      if (!match?.[1]) {
        buffer = Buffer.alloc(0);
        writeError(null, -32700, "Missing Content-Length");
        break;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) break;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.subarray(bodyStart + length);
      dispatch(body);
    }
  });
  process.stdin.on("end", () => { void session.idle().then(() => session.dispose()); });

  function dispatch(body: string): void {
    let request: LspRequest;
    try {
      const parsed = parseJson(body);
      if (!isRecord(parsed)) throw new Error("LSP body must be a JSON-RPC object");
      request = parsed;
    } catch (error) {
      writeError(null, -32700, error instanceof Error ? error.message : String(error));
      return;
    }
    void session.handle(request).then((response) => {
      if (request.id !== undefined && response !== NO_RESPONSE) writeResponse(request.id, response);
      if (request.method === "exit") {
        process.exitCode = session.wasShutdown() ? 0 : 1;
        session.dispose();
        process.stdin.destroy();
      }
    }).catch((error: unknown) => {
      if (request.id !== undefined) writeError(request.id, -32603, error instanceof Error ? error.message : String(error));
      else writeNotification("window/logMessage", { type: 1, message: String(error) });
    });
  }
}

export function createLspSession(initialConfig: Config, measure?: Measure, notify: Notify = writeNotification) {
  let config = initialConfig;
  let generation = 0;
  let findings: Promise<ScoredRecord[]> | null = null;
  let shutdown = false;
  let disposed = false;
  const published = new Set<string>();
  const workers = new Set<Worker>();
  const pending = new Set<Promise<unknown>>();
  const perform = measure ?? ((current: Config) => workerFindings(current, workers));
  let analysisTail: Promise<unknown> = Promise.resolve();
  const analyze: Measure = (current) => {
    const result = analysisTail.then(() => disposed ? [] : perform(current));
    analysisTail = result.catch(() => {});
    return result;
  };

  async function currentFindings(): Promise<ScoredRecord[]> {
    while (!disposed) {
      const version = generation;
      const promise = findings ??= analyze(config);
      try {
        const result = await promise;
        if (version === generation) return result.filter((finding) => !isSuppressed(finding));
      } catch (error) {
        if (version === generation) { findings = null; throw error; }
      }
    }
    return [];
  }

  async function handleRequest(request: LspRequest): Promise<unknown> {
    if (request.method === "initialize") return {
      capabilities: {
        textDocumentSync: { openClose: true, change: 0, save: true },
        diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: true },
        codeActionProvider: true,
        executeCommandProvider: { commands: ["tsrqlens.explainFinding"] },
      },
      serverInfo: { name: "ts-react-quality-lens", version: "0.3.0" },
    };
    if (request.method === "shutdown") { shutdown = true; return null; }
    if (request.method === "exit") return NO_RESPONSE;
    if (shutdown || disposed) throw new Error("LSP server has shut down");
    if (request.method === "workspace/didChangeConfiguration" ||
        (request.method === "textDocument/didSave" && documentUri(request.params) === pathToFileURL(config.configPath).href)) {
      config = loadConfig(config.configPath);
    }
    if (["textDocument/didSave", "workspace/didChangeConfiguration"].includes(request.method ?? "")) {
      generation += 1;
      findings = null;
    }
    if (["initialized", "textDocument/didOpen", "textDocument/didSave", "workspace/didChangeConfiguration"].includes(request.method ?? "")) {
      const records = await currentFindings();
      if (!disposed && !shutdown) publish(records);
      return NO_RESPONSE;
    }
    if (request.method === "textDocument/diagnostic") {
      const records = await currentFindings();
      const uri = documentUri(request.params);
      if (!uri) throw new Error("textDocument/diagnostic requires a document URI");
      return { kind: "full", items: diagnostics(records, relativeUri(config, uri)) };
    }
    if (request.method === "workspace/diagnostic") {
      const records = await currentFindings();
      const files = new Set([...published, ...records.flatMap((finding) => finding.file ? [finding.file] : [])]);
      return { items: [...files].map((file) => ({
        uri: pathToFileURL(path.resolve(config.projectRoot, file)).href, kind: "full", items: diagnostics(records, file),
      })) };
    }
    if (request.method === "textDocument/codeAction") return codeActions(config, request.params, await currentFindings());
    if (request.method === "workspace/executeCommand") return executeCommand(request.params, await currentFindings());
    return request.id === undefined ? NO_RESPONSE : null;
  }

  function diagnostics(records: ScoredRecord[], file: string) {
    return records.filter((finding) => finding.file === file).map((finding) => diagnosticForFinding(config, finding));
  }

  function publish(records: ScoredRecord[]): void {
    for (const finding of records) if (finding.file) published.add(finding.file);
    for (const file of published) notify("textDocument/publishDiagnostics", {
      uri: pathToFileURL(path.resolve(config.projectRoot, file)).href, diagnostics: diagnostics(records, file),
    });
  }

  return {
    handle(request: LspRequest): Promise<unknown> {
      const result = handleRequest(request);
      pending.add(result);
      void result.then(() => pending.delete(result), () => pending.delete(result));
      return result;
    },
    async idle(): Promise<void> { await Promise.allSettled([...pending]); },
    wasShutdown: () => shutdown,
    dispose(): void {
      disposed = true;
      for (const worker of workers) void worker.terminate();
    },
  };
}

function workerFindings(config: Config, workers: Set<Worker>): Promise<ScoredRecord[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./lsp-worker.js", import.meta.url), { workerData: config });
    workers.add(worker);
    let received = false;
    worker.once("message", (value: ScoredRecord[]) => { received = true; resolve(value); });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      workers.delete(worker);
      if (!received) reject(new Error(`Editor analysis exited without a result (code ${code}).`));
    });
  });
}

function documentUri(params: unknown): string | null {
  return isRecord(params) && isRecord(params.textDocument) && typeof params.textDocument.uri === "string"
    ? params.textDocument.uri : null;
}

function diagnosticForFinding(config: Config, finding: ScoredRecord) {
  return {
    range: sourceRange(finding.line ?? 1, finding.column ?? 1, finding.end_line, finding.end_column),
    severity: finding.disposition === "block" ? 1 : finding.disposition === "warn" ? 2 : finding.disposition === "info" ? 4 : 3,
    code: finding.rule_id,
    source: typeof finding.source === "string" ? finding.source : "ts-react-quality-lens",
    message: finding.message ?? String(finding.kind ?? finding.id),
    relatedInformation: finding.related_locations?.map((location) => ({
      location: {
        uri: pathToFileURL(path.resolve(config.projectRoot, location.file)).href,
        range: sourceRange(location.start_line, location.start_column ?? 1, location.end_line, location.end_column),
      },
      message: location.message ?? location.role,
    })),
    data: { finding_id: finding.id, actions: finding.actions ?? [] },
  };
}

function sourceRange(line: number, column: number, lastLine?: number | null, lastColumn?: number | null) {
  const start = { line: Math.max(0, line - 1), character: Math.max(0, column - 1) };
  const endLine = Math.max(start.line, (lastLine ?? line) - 1);
  return {
    start,
    end: {
      line: endLine,
      character: Math.max(endLine === start.line ? start.character + 1 : 0, (lastColumn ?? column + 1) - 1),
    },
  };
}

function codeActions(config: Config, params: unknown, findings: ScoredRecord[]): unknown[] {
  if (!isRecord(params) || !isRecord(params.context) || !Array.isArray(params.context.diagnostics)) return [];
  return params.context.diagnostics.flatMap((diagnostic): unknown[] => {
    if (!isRecord(diagnostic) || !isRecord(diagnostic.data)) return [];
    const id = diagnostic.data.finding_id;
    const finding = findings.find((record) => record.id === id);
    if (!finding) return [];
    const edit = suppressionEdit(config, finding);
    return [
      {
        title: `Explain ${finding.rule_id ?? "quality finding"}`,
        command: { title: "Explain finding", command: "tsrqlens.explainFinding", arguments: [finding.id] },
      },
      ...(edit ? [{ title: "Suppress this finding in project configuration", kind: "quickfix", edit }] : []),
    ];
  });
}

function executeCommand(params: unknown, findings: ScoredRecord[]): unknown {
  if (!isRecord(params) || params.command !== "tsrqlens.explainFinding" || !isUnknownArray(params.arguments)) return null;
  const id = params.arguments[0];
  return typeof id === "string" ? findings.find((finding) => finding.id === id) ?? null : null;
}

function relativeUri(config: Config, uri: string): string {
  try { return path.relative(config.projectRoot, fileURLToPath(uri)).replace(/\\/g, "/"); }
  catch { return uri; }
}

function writeResponse(id: unknown, result: unknown): void { writeMessage({ jsonrpc: "2.0", id, result }); }
function writeError(id: unknown, code: number, message: string): void { writeMessage({ jsonrpc: "2.0", id, error: { code, message } }); }
function writeNotification(method: string, params: unknown): void { writeMessage({ jsonrpc: "2.0", method, params }); }
function writeMessage(value: unknown): void {
  const body = JSON.stringify(value);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
