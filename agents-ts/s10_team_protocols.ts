#!/usr/bin/env node
/**
 * s10_team_protocols.ts - Team Protocols
 *
 * request_id based shutdown and plan approval protocols.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";
import { buildSystemPrompt, createAnthropicClient, resolveModel, shellToolDescription } from "./shared";

type MessageType = "message" | "broadcast" | "shutdown_request" | "shutdown_response" | "plan_approval_response";
type ToolName =
  | "bash" | "read_file" | "write_file" | "edit_file"
  | "spawn_teammate" | "list_teammates" | "send_message" | "read_inbox" | "broadcast"
  | "shutdown_request" | "shutdown_response" | "plan_approval";
type ToolUseBlock = { id: string; type: "tool_use"; name: ToolName; input: Record<string, unknown> };
type TextBlock = { type: "text"; text: string };
type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string };
type Message = { role: "user" | "assistant"; content: string | Array<ToolUseBlock | TextBlock | ToolResultBlock> };
type TeamMember = { name: string; role: string; status: "working" | "idle" | "shutdown" };
type TeamConfig = { team_name: string; members: TeamMember[] };

const WORKDIR = process.cwd();
const MODEL = resolveModel();
const TEAM_DIR = resolve(WORKDIR, ".team");
const INBOX_DIR = resolve(TEAM_DIR, "inbox");
const VALID_MSG_TYPES: MessageType[] = ["message", "broadcast", "shutdown_request", "shutdown_response", "plan_approval_response"];
const shutdownRequests: Record<string, { target: string; status: string }> = {};
const planRequests: Record<string, { from: string; plan: string; status: string }> = {};
const client = createAnthropicClient();

const SYSTEM = buildSystemPrompt(`You are a team lead at ${WORKDIR}. Manage teammates with shutdown and plan approval protocols.`);

function safePath(relativePath: string) {
  const filePath = resolve(WORKDIR, relativePath);
  const normalizedWorkdir = `${WORKDIR}${process.platform === "win32" ? "\\" : "/"}`;
  if (filePath !== WORKDIR && !filePath.startsWith(normalizedWorkdir)) throw new Error(`Path escapes workspace: ${relativePath}`);
  return filePath;
}

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((item) => command.includes(item))) return "Error: Dangerous command blocked";
  const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];
  const result = spawnSync(shell, args, { cwd: WORKDIR, encoding: "utf8", timeout: 120_000 });
  if (result.error?.name === "TimeoutError") return "Error: Timeout (120s)";
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return output.slice(0, 50_000) || "(no output)";
}

function runRead(path: string, limit?: number): string {
  try {
    let lines = readFileSync(safePath(path), "utf8").split(/\r?\n/);
    if (limit && limit < lines.length) lines = lines.slice(0, limit).concat(`... (${lines.length - limit} more)`);
    return lines.join("\n").slice(0, 50_000);
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function runWrite(path: string, content: string): string {
  try {
    const filePath = safePath(path);
    mkdirSync(resolve(filePath, ".."), { recursive: true });
    writeFileSync(filePath, content, "utf8");
    return `Wrote ${content.length} bytes`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function runEdit(path: string, oldText: string, newText: string): string {
  try {
    const filePath = safePath(path);
    const content = readFileSync(filePath, "utf8");
    if (!content.includes(oldText)) return `Error: Text not found in ${path}`;
    writeFileSync(filePath, content.replace(oldText, newText), "utf8");
    return `Edited ${path}`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

class MessageBus {
  constructor(private inboxDir: string) {
    mkdirSync(inboxDir, { recursive: true });
  }

  send(sender: string, to: string, content: string, msgType: MessageType = "message", extra?: Record<string, unknown>) {
    if (!VALID_MSG_TYPES.includes(msgType)) return `Error: Invalid type '${msgType}'.`;
    const payload = { type: msgType, from: sender, content, timestamp: Date.now() / 1000, ...(extra ?? {}) };
    appendFileSync(resolve(this.inboxDir, `${to}.jsonl`), `${JSON.stringify(payload)}\n`, "utf8");
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string) {
    const inboxPath = resolve(this.inboxDir, `${name}.jsonl`);
    if (!existsSync(inboxPath)) return [];
    const lines = readFileSync(inboxPath, "utf8").split(/\r?\n/).filter(Boolean);
    writeFileSync(inboxPath, "", "utf8");
    return lines.map((line) => JSON.parse(line));
  }

  broadcast(sender: string, content: string, teammates: string[]) {
    let count = 0;
    for (const name of teammates) {
      if (name === sender) continue;
      this.send(sender, name, content, "broadcast");
      count += 1;
    }
    return `Broadcast to ${count} teammates`;
  }
}

const BUS = new MessageBus(INBOX_DIR);

class TeammateManager {
  private configPath: string;
  private config: TeamConfig;

  constructor(private teamDir: string) {
    mkdirSync(teamDir, { recursive: true });
    this.configPath = resolve(teamDir, "config.json");
    this.config = this.loadConfig();
  }

  private loadConfig(): TeamConfig {
    if (existsSync(this.configPath)) return JSON.parse(readFileSync(this.configPath, "utf8")) as TeamConfig;
    return { team_name: "default", members: [] };
  }

  private saveConfig() {
    writeFileSync(this.configPath, `${JSON.stringify(this.config, null, 2)}\n`, "utf8");
  }

  private findMember(name: string) {
    return this.config.members.find((member) => member.name === name);
  }

  spawn(name: string, role: string, prompt: string) {
    let member = this.findMember(name);
    if (member) {
      if (!["idle", "shutdown"].includes(member.status)) return `Error: '${name}' is currently ${member.status}`;
      member.status = "working";
      member.role = role;
    } else {
      member = { name, role, status: "working" };
      this.config.members.push(member);
    }
    this.saveConfig();
    void this.teammateLoop(name, role, prompt);
    return `Spawned '${name}' (role: ${role})`;
  }

  private async teammateLoop(name: string, role: string, prompt: string) {
    const sysPrompt = buildSystemPrompt(`You are '${name}', role: ${role}, at ${WORKDIR}. Submit plans via plan_approval before major work. Respond to shutdown_request with shutdown_response.`);
    const messages: Message[] = [{ role: "user", content: prompt }];
    let shouldExit = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      for (const msg of BUS.readInbox(name)) messages.push({ role: "user", content: JSON.stringify(msg) });
      if (shouldExit) break;
      const response = await client.messages.create({
        model: MODEL,
        system: sysPrompt,
        messages: messages as Anthropic.Messages.MessageParam[],
        tools: this.tools() as Anthropic.Messages.Tool[],
        max_tokens: 8000,
      }).catch(() => null);
      if (!response) break;
      messages.push({ role: "assistant", content: response.content as Array<ToolUseBlock | TextBlock> });
      if (response.stop_reason !== "tool_use") break;
      const results: ToolResultBlock[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const output = this.exec(name, block.name, block.input as Record<string, unknown>);
        if (block.name === "shutdown_response" && block.input.approve) shouldExit = true;
        console.log(`  [${name}] ${block.name}: ${output.slice(0, 120)}`);
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
      }
      messages.push({ role: "user", content: results });
    }
    const member = this.findMember(name);
    if (member) {
      member.status = shouldExit ? "shutdown" : "idle";
      this.saveConfig();
    }
  }

  private tools() {
    return [
      { name: "bash", description: shellToolDescription(), input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
      { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
      { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
      { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
      { name: "send_message", description: "Send message to a teammate.", input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: VALID_MSG_TYPES } }, required: ["to", "content"] } },
      { name: "read_inbox", description: "Read and drain your inbox.", input_schema: { type: "object", properties: {} } },
      { name: "shutdown_response", description: "Respond to a shutdown request.", input_schema: { type: "object", properties: { request_id: { type: "string" }, approve: { type: "boolean" }, reason: { type: "string" } }, required: ["request_id", "approve"] } },
      { name: "plan_approval", description: "Submit a plan for lead approval.", input_schema: { type: "object", properties: { plan: { type: "string" } }, required: ["plan"] } },
    ];
  }

  private exec(sender: string, toolName: string, input: Record<string, unknown>) {
    if (toolName === "bash") return runBash(String(input.command ?? ""));
    if (toolName === "read_file") return runRead(String(input.path ?? ""), Number(input.limit ?? 0) || undefined);
    if (toolName === "write_file") return runWrite(String(input.path ?? ""), String(input.content ?? ""));
    if (toolName === "edit_file") return runEdit(String(input.path ?? ""), String(input.old_text ?? ""), String(input.new_text ?? ""));
    if (toolName === "send_message") return BUS.send(sender, String(input.to ?? ""), String(input.content ?? ""), (input.msg_type as MessageType | undefined) ?? "message");
    if (toolName === "read_inbox") return JSON.stringify(BUS.readInbox(sender), null, 2);
    if (toolName === "shutdown_response") {
      const requestId = String(input.request_id ?? "");
      shutdownRequests[requestId] = { ...(shutdownRequests[requestId] ?? { target: sender }), status: input.approve ? "approved" : "rejected" };
      BUS.send(sender, "lead", String(input.reason ?? ""), "shutdown_response", { request_id: requestId, approve: Boolean(input.approve) });
      return `Shutdown ${input.approve ? "approved" : "rejected"}`;
    }
    if (toolName === "plan_approval") {
      const requestId = randomUUID().slice(0, 8);
      planRequests[requestId] = { from: sender, plan: String(input.plan ?? ""), status: "pending" };
      BUS.send(sender, "lead", String(input.plan ?? ""), "plan_approval_response", { request_id: requestId, plan: String(input.plan ?? "") });
      return `Plan submitted (request_id=${requestId}). Waiting for lead approval.`;
    }
    return `Unknown tool: ${toolName}`;
  }
  listAll() {
    if (!this.config.members.length) return "No teammates.";
    return [`Team: ${this.config.team_name}`, ...this.config.members.map((m) => `  ${m.name} (${m.role}): ${m.status}`)].join("\n");
  }

  memberNames() {
    return this.config.members.map((m) => m.name);
  }
}

const TEAM = new TeammateManager(TEAM_DIR);

function handleShutdownRequest(teammate: string) {
  const requestId = randomUUID().slice(0, 8);
  shutdownRequests[requestId] = { target: teammate, status: "pending" };
  BUS.send("lead", teammate, "Please shut down gracefully.", "shutdown_request", { request_id: requestId });
  return `Shutdown request ${requestId} sent to '${teammate}' (status: pending)`;
}

function handlePlanReview(requestId: string, approve: boolean, feedback = "") {
  const request = planRequests[requestId];
  if (!request) return `Error: Unknown plan request_id '${requestId}'`;
  request.status = approve ? "approved" : "rejected";
  BUS.send("lead", request.from, feedback, "plan_approval_response", { request_id: requestId, approve, feedback });
  return `Plan ${request.status} for '${request.from}'`;
}

const TOOL_HANDLERS: Record<ToolName, (input: Record<string, unknown>) => string> = {
  bash: (input) => runBash(String(input.command ?? "")),
  read_file: (input) => runRead(String(input.path ?? ""), Number(input.limit ?? 0) || undefined),
  write_file: (input) => runWrite(String(input.path ?? ""), String(input.content ?? "")),
  edit_file: (input) => runEdit(String(input.path ?? ""), String(input.old_text ?? ""), String(input.new_text ?? "")),
  spawn_teammate: (input) => TEAM.spawn(String(input.name ?? ""), String(input.role ?? ""), String(input.prompt ?? "")),
  list_teammates: () => TEAM.listAll(),
  send_message: (input) => BUS.send("lead", String(input.to ?? ""), String(input.content ?? ""), (input.msg_type as MessageType | undefined) ?? "message"),
  read_inbox: () => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast: (input) => BUS.broadcast("lead", String(input.content ?? ""), TEAM.memberNames()),
  shutdown_request: (input) => handleShutdownRequest(String(input.teammate ?? "")),
  shutdown_response: (input) => JSON.stringify(shutdownRequests[String(input.request_id ?? "")] ?? { error: "not found" }),
  plan_approval: (input) => handlePlanReview(String(input.request_id ?? ""), Boolean(input.approve), String(input.feedback ?? "")),
};

const TOOLS = [
  { name: "bash", description: shellToolDescription(), input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "spawn_teammate", description: "Spawn a persistent teammate.", input_schema: { type: "object", properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } }, required: ["name", "role", "prompt"] } },
  { name: "list_teammates", description: "List all teammates.", input_schema: { type: "object", properties: {} } },
  { name: "send_message", description: "Send a message to a teammate.", input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: VALID_MSG_TYPES } }, required: ["to", "content"] } },
  { name: "read_inbox", description: "Read and drain the lead inbox.", input_schema: { type: "object", properties: {} } },
  { name: "broadcast", description: "Send a message to all teammates.", input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } },
  { name: "shutdown_request", description: "Request a teammate to shut down gracefully.", input_schema: { type: "object", properties: { teammate: { type: "string" } }, required: ["teammate"] } },
  { name: "shutdown_response", description: "Check shutdown request status by request_id.", input_schema: { type: "object", properties: { request_id: { type: "string" } }, required: ["request_id"] } },
  { name: "plan_approval", description: "Approve or reject a teammate plan.", input_schema: { type: "object", properties: { request_id: { type: "string" }, approve: { type: "boolean" }, feedback: { type: "string" } }, required: ["request_id", "approve"] } },
];

function assistantText(content: Array<ToolUseBlock | TextBlock>) {
  return content.filter((block): block is TextBlock => block.type === "text").map((block) => block.text).join("\n");
}

export async function agentLoop(messages: Message[]) {
  while (true) {
    const inbox = BUS.readInbox("lead");
    if (inbox.length) {
      messages.push({ role: "user", content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>` });
      messages.push({ role: "assistant", content: "Noted inbox messages." });
    }
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages: messages as Anthropic.Messages.MessageParam[],
      tools: TOOLS as Anthropic.Messages.Tool[],
      max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content as Array<ToolUseBlock | TextBlock> });
    if (response.stop_reason !== "tool_use") return;
    const results: ToolResultBlock[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const handler = TOOL_HANDLERS[block.name as ToolName];
      const output = handler ? handler(block.input as Record<string, unknown>) : `Unknown tool: ${block.name}`;
      console.log(`> ${block.name}: ${output.slice(0, 200)}`);
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const history: Message[] = [];
  while (true) {
    let query = "";
    try {
      query = await rl.question("\x1b[36ms10 >> \x1b[0m");
    } catch (error) {
      if (
        error instanceof Error &&
        (("code" in error && error.code === "ERR_USE_AFTER_CLOSE") || error.name === "AbortError")
      ) {
        break;
      }
      throw error;
    }
    if (!query.trim() || ["q", "exit"].includes(query.trim().toLowerCase())) break;
    if (query.trim() === "/team") { console.log(TEAM.listAll()); continue; }
    if (query.trim() === "/inbox") { console.log(JSON.stringify(BUS.readInbox("lead"), null, 2)); continue; }
    history.push({ role: "user", content: query });
    await agentLoop(history);
    const last = history[history.length - 1]?.content;
    if (Array.isArray(last)) {
      const text = assistantText(last as Array<ToolUseBlock | TextBlock>);
      if (text) console.log(text);
    }
    console.log();
  }
  rl.close();
}

void main();
