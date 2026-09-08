import fs from "node:fs";
import path from "node:path";
import { isRecord, isUnknownArray, parseJson } from "./collections.js";
import { runAudit } from "./audit.js";
import { runMeasure } from "./measure-runner.js";
import { projectContext } from "./context.js";
import { packageRootFrom } from "./package-root.js";
import { catalogForConfig, TASKS } from "./tasks.js";
import { readArtifact } from "./writer.js";
import { artifactFindings } from "./findings.js";
import type { Config, ScoredRecord } from "./types.js";

type JsonRpcRequest = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
type McpTool = { name: string; description: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint: boolean } };

const TOOLS = [
  { name: "catalog", description: "Return the quality task catalog.", inputSchema: { type: "object", properties: {} } },
  { name: "context", description: "Analyze and return compact project context.", inputSchema: { type: "object", properties: {} } },
  {
    name: "measure",
    description: "Analyze code and write artifacts without running configured tests. Project tooling may execute configuration.",
    annotations: { readOnlyHint: false },
    inputSchema: { type: "object", required: ["task_id"], properties: { task_id: { type: "string" } } },
  },
  {
    name: "audit",
    description: "Run a changed-code audit. Tests only execute when run_tests is explicitly true; required tests otherwise remain incomplete.",
    annotations: { readOnlyHint: false },
    inputSchema: { type: "object", properties: {
      base: { type: "string" }, gate: { enum: ["new-only", "all"] }, run_tests: { type: "boolean", default: false },
    } },
  },
  {
    name: "run_tests",
    description: "Execute the configured project test command. This runs project code and can modify files.",
    annotations: { readOnlyHint: false },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "explain",
    description: "Return an emitted finding and its rule contract when available.",
    inputSchema: { type: "object", required: ["finding_id"], properties: { finding_id: { type: "string" } } },
  },
] satisfies readonly McpTool[];

export function runMcpServer(config: Config): void {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) handleLine(config, line);
    }
  });
}

function handleLine(config: Config, line: string): void {
  const request = parseRequest(line);
  if (!request) {
    writeError(null, -32700, "Parse error");
    return;
  }
  if (request.id === undefined) return;
  try {
    writeResult(request.id, dispatchMcp(config, request));
  } catch (error) {
    writeError(request.id, -32603, error instanceof Error ? error.message : String(error));
  }
}

function parseRequest(line: string): JsonRpcRequest | null {
  try {
    const value = parseJson(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function dispatchMcp(config: Config, request: JsonRpcRequest): unknown {
  if (request.method === "initialize") return {
    protocolVersion: "2025-03-26",
    capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
    serverInfo: { name: "ts-react-quality-lens", version: "0.3.0" },
  };
  if (request.method === "ping") return {};
  if (request.method === "tools/list") return { tools: TOOLS };
  if (request.method === "resources/list") return {
    resources: artifactResources().map(([artifact, name]) => ({ uri: `tsrqlens://artifact/${artifact}`, name, mimeType: "application/json" })),
  };
  if (request.method === "resources/read") return readResource(config, request.params);
  if (request.method === "tools/call") return callTool(config, request.params);
  throw new Error(`Unsupported MCP method ${request.method ?? "unknown"}`);
}

type ToolHandler = (config: Config, args: Record<string, unknown>) => unknown;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  catalog: (config) => catalogForConfig(config),
  context: (config) => projectContext(config, "mcp context"),
  measure: (config, args) => {
    const taskId = requiredString(args, "task_id", "measure");
    return runMeasure(config, taskId, `mcp measure ${taskId}`, { allowTestExecution: false });
  },
  audit: (config, args) => runAudit(config, "mcp audit", {
    base: typeof args.base === "string" ? args.base : null,
    gate: args.gate === "all" || args.gate === "new-only" ? args.gate : null,
    runTests: args.run_tests === true,
  }),
  run_tests: (config) => runMeasure(config, "correctness.all", "mcp run_tests"),
  explain: (config, args) => explainFinding(config, requiredString(args, "finding_id", "explain")),
};

function callTool(config: Config, params: unknown): unknown {
  if (!isRecord(params) || typeof params.name !== "string") throw new Error("tools/call requires a tool name");
  const handler = TOOL_HANDLERS[params.name];
  if (!handler) throw new Error(`Unknown MCP tool ${params.name}`);
  return toolContent(handler(config, isRecord(params.arguments) ? params.arguments : {}));
}

function requiredString(args: Record<string, unknown>, name: string, tool: string): string {
  const value = args[name];
  if (typeof value !== "string") throw new Error(`${tool} requires ${name}`);
  return value;
}

function readResource(config: Config, params: unknown): unknown {
  if (!isRecord(params) || typeof params.uri !== "string" || !params.uri.startsWith("tsrqlens://artifact/")) {
    throw new Error("resources/read requires a tsrqlens artifact URI");
  }
  const artifact = params.uri.slice("tsrqlens://artifact/".length);
  if (!artifactResources().some(([name]) => name === artifact)) throw new Error("Unknown artifact resource");
  const value = readArtifact(config, artifact);
  if (!value) throw new Error(`Artifact ${artifact} has not been measured`);
  return { contents: [{ uri: params.uri, mimeType: "application/json", text: JSON.stringify(value, null, 2) }] };
}

function artifactResources(): Array<[string, string]> {
  return [["audit.json", "Changed-code audit"], ["context.json", "Project context"],
    ...TASKS.map((task): [string, string] => [task.artifact, task.title])];
}

function explainFinding(config: Config, findingId: string): unknown {
  let finding: ScoredRecord | null = null;
  for (const [name] of artifactResources()) {
    finding = artifactFindings(readArtifact(config, name)).find((record) => record.id === findingId) ?? null;
    if (finding) break;
  }
  if (!finding) throw new Error(`Finding ${findingId} was not found in measured artifacts`);
  const contractsPath = path.join(packageRootFrom(import.meta.url), "rule-contracts.json");
  const contracts = fs.existsSync(contractsPath) ? parseJson(fs.readFileSync(contractsPath, "utf8")) : null;
  const rules = isRecord(contracts) && isUnknownArray(contracts.rules) ? contracts.rules : [];
  const contract = rules.find((rule) => isRecord(rule) && rule.id === finding?.rule_id) ?? null;
  return { finding, contract };
}

function toolContent(value: unknown): unknown {
  const text = JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], structuredContent: value };
}

function writeResult(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeError(id: unknown, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}
