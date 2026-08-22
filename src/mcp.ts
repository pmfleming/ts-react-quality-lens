import fs from "node:fs";
import path from "node:path";
import { isRecord } from "./collections.js";
import { runAudit } from "./audit.js";
import { runMeasure } from "./cli.js";
import { projectContext } from "./context.js";
import { packageRootFrom } from "./package-root.js";
import { catalogForConfig, TASKS } from "./tasks.js";
import { readArtifact } from "./writer.js";
import type { Artifact, Config, ScoredRecord } from "./types.js";

type JsonRpcRequest = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };

const TOOLS = [
  { name: "catalog", description: "Return the quality task catalog.", inputSchema: { type: "object", properties: {} } },
  { name: "context", description: "Analyze and return compact project context.", inputSchema: { type: "object", properties: {} } },
  {
    name: "measure",
    description: "Run a read-only quality measurement.",
    inputSchema: { type: "object", required: ["task_id"], properties: { task_id: { type: "string" } } },
  },
  {
    name: "audit",
    description: "Run the changed-code quality audit.",
    inputSchema: { type: "object", properties: { base: { type: "string" }, gate: { enum: ["new-only", "all"] } } },
  },
  {
    name: "explain",
    description: "Return an emitted finding and its rule contract when available.",
    inputSchema: { type: "object", required: ["finding_id"], properties: { finding_id: { type: "string" } } },
  },
] as const;

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
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    writeError(null, -32700, "Parse error");
    return;
  }
  if (request.id === undefined) return;
  try {
    writeResult(request.id, dispatch(config, request));
  } catch (error) {
    writeError(request.id, -32603, error instanceof Error ? error.message : String(error));
  }
}

function dispatch(config: Config, request: JsonRpcRequest): unknown {
  if (request.method === "initialize") return {
    protocolVersion: "2025-03-26",
    capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
    serverInfo: { name: "ts-react-quality-lens", version: "0.3.0" },
  };
  if (request.method === "ping") return {};
  if (request.method === "tools/list") return { tools: TOOLS };
  if (request.method === "resources/list") return {
    resources: TASKS.map((task) => ({ uri: `tsrqlens://artifact/${task.artifact}`, name: task.title, mimeType: "application/json" })),
  };
  if (request.method === "resources/read") return readResource(config, request.params);
  if (request.method === "tools/call") return callTool(config, request.params);
  throw new Error(`Unsupported MCP method ${request.method ?? "unknown"}`);
}

function callTool(config: Config, params: unknown): unknown {
  if (!isRecord(params) || typeof params.name !== "string") throw new Error("tools/call requires a tool name");
  const args = isRecord(params.arguments) ? params.arguments : {};
  let value: unknown;
  if (params.name === "catalog") value = catalogForConfig(config);
  else if (params.name === "context") value = projectContext(config, "mcp context");
  else if (params.name === "measure") {
    if (typeof args.task_id !== "string") throw new Error("measure requires task_id");
    value = runMeasure(config, args.task_id, `mcp measure ${args.task_id}`);
  } else if (params.name === "audit") {
    value = runAudit(config, "mcp audit", {
      base: typeof args.base === "string" ? args.base : null,
      gate: args.gate === "all" || args.gate === "new-only" ? args.gate : null,
    });
  } else if (params.name === "explain") {
    if (typeof args.finding_id !== "string") throw new Error("explain requires finding_id");
    value = explainFinding(config, args.finding_id);
  } else throw new Error(`Unknown MCP tool ${params.name}`);
  return toolContent(value);
}

function readResource(config: Config, params: unknown): unknown {
  if (!isRecord(params) || typeof params.uri !== "string" || !params.uri.startsWith("tsrqlens://artifact/")) {
    throw new Error("resources/read requires a tsrqlens artifact URI");
  }
  const artifact = params.uri.slice("tsrqlens://artifact/".length);
  const value = readArtifact(config, artifact);
  if (!value) throw new Error(`Artifact ${artifact} has not been measured`);
  return { contents: [{ uri: params.uri, mimeType: "application/json", text: JSON.stringify(value, null, 2) }] };
}

function explainFinding(config: Config, findingId: string): unknown {
  let finding: ScoredRecord | null = null;
  for (const task of TASKS) {
    const artifact = readArtifact<Artifact>(config, task.artifact);
    finding = artifact?.records?.find((record) => record.id === findingId) ?? finding;
  }
  if (!finding) throw new Error(`Finding ${findingId} was not found in measured artifacts`);
  const contractsPath = path.join(packageRootFrom(import.meta.url), "rule-contracts.json");
  const contracts: unknown = fs.existsSync(contractsPath) ? JSON.parse(fs.readFileSync(contractsPath, "utf8")) : null;
  const rules = isRecord(contracts) && Array.isArray(contracts.rules) ? contracts.rules : [];
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
