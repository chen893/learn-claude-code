#!/usr/bin/env node
/**
 * s08_background_tasks.ts - Background Tasks
 *
 * Run commands in background child processes and inject notifications later.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";
import { buildSystemPrompt, createAnthropicClient, resolveModel, shellToolDescription } from "./shared";

type ToolName = "bash" | "read_file" | "write_file" | "edit_file" | "background_run" | "check_background";
type ToolUseBlock = { id: string; type: "tool_use"; name: ToolName; input: Record<string, unknown> };
type TextBlock = { type: "text"; text: string };
type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string };
type Message = { role: "user" | "assistant"; content: string | Array<ToolUseBlock | TextBlock | ToolResultBlock> };

type BackgroundTask = {
  status: "running" | "completed" | "timeout" | "error";
  result: string | null;
  command: string;
};

const WORKDIR = process.cwd();
const MODEL = resolveModel();
const client = createAnthropicClient();

const SYSTEM = buildSystemPrompt(`You are a coding agent at ${WORKDIR}. Use background_run for long-running commands.`);

function safePath(relativePath: string) {
  const filePath = resolve(WORKDIR, relativePath);
  const normalizedWorkdir = `${WORKDIR}${process.platform === "win32" ? "\\" : "/"}`;
  if (filePath !== WORKDIR && !filePath.startsWith(normalizedWorkdir)) throw new Error(`Path escapes workspace: ${relativePath}`);
  return filePath;
}

function runCommand(command: string, cwd: string, timeout = 120_000): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((item) => command.includes(item))) return "Error: Dangerous command blocked";
  const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];
  const result = spawnSync(shell, args, { cwd, encoding: "utf8", timeout });
  if (result.error?.name === "TimeoutError") return `Error: Timeout (${Math.floor(timeout / 1000)}s)`;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return output.slice(0, 50_000) || "(no output)";
}

function runBash(command: string): string {
  return runCommand(command, WORKDIR, 120_000);
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

class BackgroundManager {
  tasks: Record<string, BackgroundTask> = {};
  private notificationQueue: Array<{ task_id: string; status: string; command: string; result: string }> = [];

  run(command: string): string {
    const taskId = randomUUID().slice(0, 8);
    this.tasks[taskId] = { status: "running", result: null, command };

    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];
    const child = spawn(shell, args, { cwd: WORKDIR, stdio: ["ignore", "pipe", "pipe"] });

    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      this.tasks[taskId].status = "timeout";
      this.tasks[taskId].result = "Error: Timeout (300s)";
      this.notificationQueue.push({
        task_id: taskId,
        status: "timeout",
        command: command.slice(0, 80),
        result: "Error: Timeout (300s)",
      });
    }, 300_000);

    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      this.tasks[taskId].status = "error";
      this.tasks[taskId].result = `Error: ${error.message}`;
      this.notificationQueue.push({
        task_id: taskId,
        status: "error",
        command: command.slice(0, 80),
        result: `Error: ${error.message}`.slice(0, 500),
      });
    });
    child.on("close", () => {
      if (this.tasks[taskId].status !== "running") return;
      clearTimeout(timer);
      const result = output.trim().slice(0, 50_000) || "(no output)";
      this.tasks[taskId].status = "completed";
      this.tasks[taskId].result = result;
      this.notificationQueue.push({
        task_id: taskId,
        status: "completed",
        command: command.slice(0, 80),
        result: result.slice(0, 500),
      });
    });

    return `Background task ${taskId} started: ${command.slice(0, 80)}`;
  }

  check(taskId?: string): string {
    if (taskId) {
      const task = this.tasks[taskId];
      if (!task) return `Error: Unknown task ${taskId}`;
      return `[${task.status}] ${task.command.slice(0, 60)}\n${task.result ?? "(running)"}`;
    }
    const lines = Object.entries(this.tasks).map(([id, task]) => `${id}: [${task.status}] ${task.command.slice(0, 60)}`);
    return lines.length ? lines.join("\n") : "No background tasks.";
  }

  drainNotifications() {
    const notifications = [...this.notificationQueue];
    this.notificationQueue = [];
    return notifications;
  }
}

const BG = new BackgroundManager();

const TOOL_HANDLERS: Record<ToolName, (input: Record<string, unknown>) => string> = {
  bash: (input) => runBash(String(input.command ?? "")),
  read_file: (input) => runRead(String(input.path ?? ""), Number(input.limit ?? 0) || undefined),
  write_file: (input) => runWrite(String(input.path ?? ""), String(input.content ?? "")),
  edit_file: (input) => runEdit(String(input.path ?? ""), String(input.old_text ?? ""), String(input.new_text ?? "")),
  background_run: (input) => BG.run(String(input.command ?? "")),
  check_background: (input) => BG.check(typeof input.task_id === "string" ? input.task_id : undefined),
};

const TOOLS = [
  { name: "bash", description: shellToolDescription(), input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "background_run", description: "Run command in background. Returns task_id immediately.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "check_background", description: "Check background task status. Omit task_id to list all.", input_schema: { type: "object", properties: { task_id: { type: "string" } } } },
];

function assistantText(content: Array<ToolUseBlock | TextBlock>) {
  return content.filter((block): block is TextBlock => block.type === "text").map((block) => block.text).join("\n");
}

export async function agentLoop(messages: Message[]) {
  while (true) {
    const notifications = BG.drainNotifications();
    if (notifications.length && messages.length) {
      const notifText = notifications.map((n) => `[bg:${n.task_id}] ${n.status}: ${n.result}`).join("\n");
      messages.push({ role: "user", content: `<background-results>\n${notifText}\n</background-results>` });
      messages.push({ role: "assistant", content: "Noted background results." });
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
      let output = "";
      try {
        output = handler ? handler(block.input as Record<string, unknown>) : `Unknown tool: ${block.name}`;
      } catch (error) {
        output = `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
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
      query = await rl.question("\x1b[36ms08 >> \x1b[0m");
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
