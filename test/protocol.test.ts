import assert from "node:assert/strict";
import childProcess from "node:child_process";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve();
const bin = path.join(root, "dist", "bin", "ts-react-quality-lens.js");
const config = path.join(root, "examples", "basic", "ts-react-quality-lens.config.json");

test("MCP server exposes read-only quality tools", async () => {
  const response = await exchange(
    "mcp",
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
    (output) => {
      const line = output.split("\n").find((item) => item.trim().startsWith("{"));
      return line ? JSON.parse(line) : null;
    },
  );
  assert.equal(response.result.serverInfo.name, "ts-react-quality-lens");
  assert.equal(response.result.capabilities.tools?.listChanged, false);
});

test("LSP server advertises diagnostics and code actions", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } });
  const response = await exchange(
    "lsp",
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    (output) => {
      const split = output.indexOf("\r\n\r\n");
      if (split < 0) return null;
      const match = /Content-Length:\s*(\d+)/i.exec(output.slice(0, split));
      if (!match?.[1]) return null;
      const length = Number(match[1]);
      const responseBody = output.slice(split + 4);
      return Buffer.byteLength(responseBody) >= length ? JSON.parse(responseBody.slice(0, length)) : null;
    },
  );
  assert.equal(response.result.serverInfo.name, "ts-react-quality-lens");
  assert.equal(response.result.capabilities.codeActionProvider, true);
  assert.equal(response.result.capabilities.diagnosticProvider?.workspaceDiagnostics, true);
});

type ProtocolResponse = {
  result: {
    serverInfo: { name: string };
    capabilities: {
      tools?: { listChanged: boolean };
      codeActionProvider?: boolean;
      diagnosticProvider?: { workspaceDiagnostics: boolean };
    };
  };
};

function exchange(
  command: "mcp" | "lsp",
  input: string,
  parse: (output: string) => ProtocolResponse | null,
): Promise<ProtocolResponse> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [bin, command, "--config", config], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} protocol response timed out: ${errors}`));
    }, 10_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { errors += chunk; });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      const parsed = parse(output);
      if (!parsed) return;
      clearTimeout(timer);
      child.kill();
      resolve(parsed);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.end(input);
  });
}
