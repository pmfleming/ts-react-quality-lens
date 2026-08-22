import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAnalysisContext } from "./analysis-context.js";
import { isRecord, isUnknownArray, parseJson } from "./collections.js";
import { runMeasure } from "./measure-runner.js";
import { TASKS } from "./tasks.js";
import { readArtifact } from "./writer.js";
import type { Config, ScoredRecord } from "./types.js";

type LspRequest = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
const LSP_TASKS = [
  "quality.type_health",
  "quality.lint",
  "quality.dependency_health",
  "quality.react_health",
  "quality.cleanup",
  "quality.sarif",
  "quality.runtime",
];

export function runLspServer(config: Config): void {
  let buffer = Buffer.alloc(0);
  let shutdown = false;
  let findings: ScoredRecord[] | null = null;
  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match?.[1]) {
        buffer = Buffer.alloc(0);
        break;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) break;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.subarray(bodyStart + length);
      try {
        const request = lspRequest(parseJson(body));
        if (!request) throw new Error("LSP body must be a JSON-RPC object");
        if (request.method === "textDocument/didSave" || request.method === "workspace/didChangeConfiguration") findings = null;
        const response = handleRequest(config, request, () => findings ??= measureFindings(config), shutdown);
        if (request.method === "shutdown") shutdown = true;
        if (request.method === "exit") process.exitCode = shutdown ? 0 : 1;
        if (request.id !== undefined && response !== NO_RESPONSE) writeResponse(request.id, response);
      } catch (error) {
        writeError(null, -32700, error instanceof Error ? error.message : String(error));
      }
    }
  });
}

const NO_RESPONSE = Symbol("no-response");

function handleRequest(
  config: Config,
  request: LspRequest,
  getFindings: () => ScoredRecord[],
  shutdown: boolean,
): unknown {
  if (request.method === "initialize") return {
    capabilities: {
      textDocumentSync: { openClose: true, change: 0, save: true },
      diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: true },
      codeActionProvider: true,
      executeCommandProvider: { commands: ["tsrqlens.explainFinding"] },
    },
    serverInfo: { name: "ts-react-quality-lens", version: "0.3.0" },
  };
  if (request.method === "initialized") {
    publishDiagnostics(config, getFindings());
    return NO_RESPONSE;
  }
  if (request.method === "shutdown") return null;
  if (request.method === "exit") return NO_RESPONSE;
  if (shutdown) throw new Error("LSP server has shut down");
  if (request.method === "textDocument/diagnostic") return documentDiagnostic(config, request.params, getFindings());
  if (request.method === "workspace/diagnostic") return workspaceDiagnostics(config, getFindings());
  if (request.method === "textDocument/codeAction") return codeActions(request.params);
  if (request.method === "workspace/executeCommand") return executeCommand(request.params, getFindings());
  if (["textDocument/didOpen", "textDocument/didSave", "workspace/didChangeConfiguration"].includes(request.method ?? "")) {
    publishDiagnostics(config, getFindings());
    return NO_RESPONSE;
  }
  return request.id === undefined ? NO_RESPONSE : null;
}

function measureFindings(config: Config): ScoredRecord[] {
  const context = createAnalysisContext(config);
  for (const taskId of LSP_TASKS) runMeasure(config, taskId, `lsp ${taskId}`, { context });
  return LSP_TASKS.flatMap((taskId) => {
    const task = TASKS.find((candidate) => candidate.id === taskId);
    const artifact = task ? readArtifact(config, task.artifact) : null;
    return [...(artifact?.records ?? []), ...findingGroups(artifact?.groups)];
  });
}

function lspRequest(value: unknown): LspRequest | null {
  return isRecord(value) ? value : null;
}

function findingGroups(value: unknown): ScoredRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is ScoredRecord => isRecord(item) && typeof item.id === "string")
    : [];
}

function publishDiagnostics(config: Config, findings: ScoredRecord[]): void {
  const byFile = new Map<string, ScoredRecord[]>();
  for (const finding of findings) {
    if (!finding.file) continue;
    byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding]);
  }
  for (const [file, records] of byFile) {
    writeNotification("textDocument/publishDiagnostics", {
      uri: pathToFileURL(path.resolve(config.projectRoot, file)).href,
      diagnostics: records.map((finding) => diagnosticForFinding(config, finding)),
    });
  }
}

function documentDiagnostic(config: Config, params: unknown, findings: ScoredRecord[]): unknown {
  const uri = isRecord(params) && isRecord(params.textDocument) && typeof params.textDocument.uri === "string"
    ? params.textDocument.uri
    : null;
  if (!uri) throw new Error("textDocument/diagnostic requires a document URI");
  const file = relativeUri(config, uri);
  return {
    kind: "full",
    items: findings.filter((finding) => finding.file === file).map((finding) => diagnosticForFinding(config, finding)),
  };
}

function workspaceDiagnostics(config: Config, findings: ScoredRecord[]): unknown {
  const files = new Set(findings.flatMap((finding) => finding.file ? [finding.file] : []));
  return {
    items: [...files].map((file) => ({
      uri: pathToFileURL(path.resolve(config.projectRoot, file)).href,
      kind: "full",
      items: findings.filter((finding) => finding.file === file).map((finding) => diagnosticForFinding(config, finding)),
    })),
  };
}

function diagnosticForFinding(config: Config, finding: ScoredRecord) {
  const startLine = Math.max(0, (finding.line ?? 1) - 1);
  const startCharacter = Math.max(0, (finding.column ?? 1) - 1);
  const endLine = Math.max(startLine, (finding.end_line ?? finding.line ?? 1) - 1);
  const endCharacter = Math.max(startCharacter + 1, (finding.end_column ?? (finding.column ?? 1) + 1) - 1);
  return {
    range: {
      start: { line: startLine, character: startCharacter },
      end: { line: endLine, character: endCharacter },
    },
    severity: finding.disposition === "block" ? 1 : finding.disposition === "warn" ? 2 : finding.disposition === "info" ? 4 : 3,
    code: finding.rule_id,
    source: typeof finding.source === "string" ? finding.source : "ts-react-quality-lens",
    message: finding.message ?? String(finding.kind ?? finding.id),
    relatedInformation: finding.related_locations?.map((location) => ({
      location: {
        uri: pathToFileURL(path.resolve(config.projectRoot, location.file)).href,
        range: {
          start: { line: Math.max(0, location.start_line - 1), character: Math.max(0, (location.start_column ?? 1) - 1) },
          end: {
            line: Math.max(0, (location.end_line ?? location.start_line) - 1),
            character: Math.max(1, (location.end_column ?? location.start_column ?? 1)),
          },
        },
      },
      message: location.message ?? location.role,
    })),
    data: { finding_id: finding.id, actions: finding.actions ?? [] },
  };
}

function codeActions(params: unknown): unknown[] {
  if (!isRecord(params) || !isRecord(params.context) || !Array.isArray(params.context.diagnostics)) return [];
  return params.context.diagnostics.flatMap((diagnostic): unknown[] => {
    if (!isRecord(diagnostic) || !isRecord(diagnostic.data) || typeof diagnostic.data.finding_id !== "string") return [];
    return [{
      title: `Explain ${String(diagnostic.code ?? "quality finding")}`,
      kind: "quickfix",
      command: {
        title: "Explain finding",
        command: "tsrqlens.explainFinding",
        arguments: [diagnostic.data.finding_id],
      },
    }];
  });
}

function executeCommand(params: unknown, findings: ScoredRecord[]): unknown {
  if (!isRecord(params) || params.command !== "tsrqlens.explainFinding" || !isUnknownArray(params.arguments)) return null;
  const id = params.arguments[0];
  return typeof id === "string" ? findings.find((finding) => finding.id === id) ?? null : null;
}

function relativeUri(config: Config, uri: string): string {
  try {
    return path.relative(config.projectRoot, fileURLToPath(uri)).replace(/\\/g, "/");
  } catch {
    return uri;
  }
}

function writeResponse(id: unknown, result: unknown): void {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function writeError(id: unknown, code: number, message: string): void {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

function writeNotification(method: string, params: unknown): void {
  writeMessage({ jsonrpc: "2.0", method, params });
}

function writeMessage(value: unknown): void {
  const body = JSON.stringify(value);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
