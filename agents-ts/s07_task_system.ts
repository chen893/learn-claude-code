#!/usr/bin/env node
/**
 * s07_task_system.ts - Tasks
 *
 * Persistent task graph stored in .tasks/.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";
import { buildSystemPrompt, createAnthropicClient, resolveModel, shellToolDescription } from "./shared";

type TaskStatus = "pending" | "in_progress" | "completed";
type ToolName =
  | "bash"
  | "read_file"
  | "write_file"
  | "edit_file"
  | "task_create"
  | "task_update"
  | "task_list"
  | "task_get";

type Task = {
  id: number;
  subject: string;
  description: string;
  status: TaskStatus;
  blockedBy: number[];
  blocks: number[];
  owner: string;
};

type ToolUseBlock = { id: string; type: "tool_use"; name: ToolName; input: Record<string, unknown> };
type TextBlock = { type: "text"; text: string };
type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string };
type Message = { role: "user" | "assistant"; content: string | Array<ToolUseBlock | TextBlock | ToolResultBlock> };

const WORKDIR = process.cwd();
const MODEL = resolveModel();
const TASKS_DIR = resolve(WORKDIR, ".tasks");
const client = createAnthropicClient();

const SYSTEM = buildSystemPrompt(`You are a coding agent at ${WORKDIR}. Use task tools to plan and track work.`);

function safePath(relativePath: string) {
  const filePath = resolve(WORKDIR, relativePath);
  const normalizedWorkdir = `${WORKDIR}${process.platform === "win32" ? "\\" : "/"}`;
  if (filePath !== WORKDIR && !filePath.startsWith(normalizedWorkdir)) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }
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

class TaskManager {
  private nextId: number;

  constructor(private tasksDir: string) {
    mkdirSync(tasksDir, { recursive: true });
    this.nextId = this.maxId() + 1;
  }

  private maxId(): number {
    return readdirSync(this.tasksDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^task_\d+\.json$/.test(entry.name))
      .map((entry) => Number(entry.name.match(/\d+/)?.[0] ?? 0))
      .reduce((max, id) => Math.max(max, id), 0);
  }

  private filePath(taskId: number) {
    return resolve(this.tasksDir, `task_${taskId}.json`);
  }

  private load(taskId: number): Task {
    const path = this.filePath(taskId);
    if (!existsSync(path)) throw new Error(`Task ${taskId} not found`);
    return JSON.parse(readFileSync(path, "utf8")) as Task;
  }

  private save(task: Task) {
    writeFileSync(this.filePath(task.id), `${JSON.stringify(task, null, 2)}\n`, "utf8");
  }

  create(subject: string, description = "") {
    const task: Task = {
      id: this.nextId,
      subject,
      description,
      status: "pending",
      blockedBy: [],
      blocks: [],
      owner: "",
    };
    this.save(task);
    this.nextId += 1;
    return JSON.stringify(task, null, 2);
  }

  get(taskId: number) {
    return JSON.stringify(this.load(taskId), null, 2);
  }

  private clearDependency(completedId: number) {
    for (const entry of readdirSync(this.tasksDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^task_\d+\.json$/.test(entry.name)) continue;
      const path = resolve(this.tasksDir, entry.name);
      const task = JSON.parse(readFileSync(path, "utf8")) as Task;
      if (task.blockedBy.includes(completedId)) {
        task.blockedBy = task.blockedBy.filter((id) => id !== completedId);
        this.save(task);
      }
    }
  }

  update(taskId: number, status?: string, addBlockedBy?: number[], addBlocks?: number[]) {
    const task = this.load(taskId);
    if (status) {
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status as TaskStatus;
      if (task.status === "completed") this.clearDependency(taskId);
    }
    if (addBlockedBy?.length) task.blockedBy = [...new Set(task.blockedBy.concat(addBlockedBy))];
    if (addBlocks?.length) {
      task.blocks = [...new Set(task.blocks.concat(addBlocks))];
      for (const blockedId of addBlocks) {
        try {
          const blocked = this.load(blockedId);
          if (!blocked.blockedBy.includes(taskId)) {
            blocked.blockedBy.push(taskId);
            this.save(blocked);
          }
        } catch {}
      }
    }
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  listAll() {
    const tasks = readdirSync(this.tasksDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^task_\d+\.json$/.test(entry.name))
      .map((entry) => JSON.parse(readFileSync(resolve(this.tasksDir, entry.name), "utf8")) as Task)
      .sort((a, b) => a.id - b.id);
    if (!tasks.length) return "No tasks.";
    return tasks
      .map((task) => {
        const marker = { pending: "[ ]", in_progress: "[>]", completed: "[x]" }[task.status] ?? "[?]";
        const blocked = task.blockedBy.length ? ` (blocked by: ${JSON.stringify(task.blockedBy)})` : "";
        return `${marker} #${task.id}: ${task.subject}${blocked}`;
      })
      .join("\n");
  }
}

const TASKS = new TaskManager(TASKS_DIR);

const TOOL_HANDLERS: Record<ToolName, (input: Record<string, unknown>) => string> = {
  bash: (input) => runBash(String(input.command ?? "")),
  read_file: (input) => runRead(String(input.path ?? ""), Number(input.limit ?? 0) || undefined),
  write_file: (input) => runWrite(String(input.path ?? ""), String(input.content ?? "")),
  edit_file: (input) => runEdit(String(input.path ?? ""), String(input.old_text ?? ""), String(input.new_text ?? "")),
  task_create: (input) => TASKS.create(String(input.subject ?? ""), String(input.description ?? "")),
  task_update: (input) => TASKS.update(
    Number(input.task_id ?? 0),
    typeof input.status === "string" ? input.status : undefined,
    Array.isArray(input.addBlockedBy) ? input.addBlockedBy.map(Number) : undefined,
    Array.isArray(input.addBlocks) ? input.addBlocks.map(Number) : undefined,
  ),
  task_list: () => TASKS.listAll(),
  task_get: (input) => TASKS.get(Number(input.task_id ?? 0)),
};

const TOOLS = [
  { name: "bash", description: shellToolDescription(), input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "task_create", description: "Create a new task.", input_schema: { type: "object", properties: { subject: { type: "string" }, description: { type: "string" } }, required: ["subject"] } },
  { name: "task_update", description: "Update a task's status or dependencies.", input_schema: { type: "object", properties: { task_id: { type: "integer" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] }, addBlockedBy: { type: "array", items: { type: "integer" } }, addBlocks: { type: "array", items: { type: "integer" } } }, required: ["task_id"] } },
  { name: "task_list", description: "List all tasks with status summary.", input_schema: { type: "object", properties: {} } },
  { name: "task_get", description: "Get full details of a task by ID.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
];

function assistantText(content: Array<ToolUseBlock | TextBlock>) {
  return content.filter((block): block is TextBlock => block.type === "text").map((block) => block.text).join("\n");
}

export async function agentLoop(messages: Message[]) {
  while (true) {
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
      query = await rl.question("\x1b[36ms07 >> \x1b[0m");
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
