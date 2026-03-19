#!/usr/bin/env node
/**
 * s12_worktree_task_isolation.ts - Worktree + Task Isolation
 *
 * Task board as control plane, git worktrees as execution plane.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";
import { buildSystemPrompt, createAnthropicClient, resolveModel, shellToolDescription } from "./shared";

type TaskStatus = "pending" | "in_progress" | "completed";
type ToolName =
  | "bash" | "read_file" | "write_file" | "edit_file"
  | "task_create" | "task_list" | "task_get" | "task_update" | "task_bind_worktree"
  | "worktree_create" | "worktree_list" | "worktree_status" | "worktree_run" | "worktree_keep" | "worktree_remove" | "worktree_events";
type ToolUseBlock = { id: string; type: "tool_use"; name: ToolName; input: Record<string, unknown> };
type TextBlock = { type: "text"; text: string };
type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string };
type Message = { role: "user" | "assistant"; content: string | Array<ToolUseBlock | TextBlock | ToolResultBlock> };
type TaskRecord = {
  id: number;
  subject: string;
  description: string;
  status: TaskStatus;
  owner: string;
  worktree: string;
  blockedBy: number[];
  created_at: number;
  updated_at: number;
};
type WorktreeRecord = {
  name: string;
  path: string;
  branch: string;
  task_id?: number;
  status: string;
  created_at: number;
  removed_at?: number;
  kept_at?: number;
};

const WORKDIR = process.cwd();
const MODEL = resolveModel();

function detectRepoRoot(cwd: string) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) return cwd;
  return result.stdout.trim() || cwd;
}

const REPO_ROOT = detectRepoRoot(WORKDIR);
const TASKS_DIR = resolve(REPO_ROOT, ".tasks");
const WORKTREES_DIR = resolve(REPO_ROOT, ".worktrees");
const EVENTS_PATH = resolve(WORKTREES_DIR, "events.jsonl");
const INDEX_PATH = resolve(WORKTREES_DIR, "index.json");

const client = createAnthropicClient();

const SYSTEM = buildSystemPrompt(`You are a coding agent at ${WORKDIR}. Use task + worktree tools for multi-task work.`);

function safePath(relativePath: string) {
  const filePath = resolve(WORKDIR, relativePath);
  const normalizedWorkdir = `${WORKDIR}${process.platform === "win32" ? "\\" : "/"}`;
  if (filePath !== WORKDIR && !filePath.startsWith(normalizedWorkdir)) throw new Error(`Path escapes workspace: ${relativePath}`);
  return filePath;
}

function runCommand(command: string, cwd: string, timeout = 120_000) {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((item) => command.includes(item))) return "Error: Dangerous command blocked";
  const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];
  const result = spawnSync(shell, args, { cwd, encoding: "utf8", timeout });
  if (result.error?.name === "TimeoutError") return `Error: Timeout (${Math.floor(timeout / 1000)}s)`;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return output.slice(0, 50_000) || "(no output)";
}

function runBash(command: string) { return runCommand(command, WORKDIR, 120_000); }
function runRead(path: string, limit?: number) {
  try {
    let lines = readFileSync(safePath(path), "utf8").split(/\r?\n/);
    if (limit && limit < lines.length) lines = lines.slice(0, limit).concat(`... (${lines.length - limit} more)`);
    return lines.join("\n").slice(0, 50_000);
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
function runWrite(path: string, content: string) {
  try {
    const filePath = safePath(path);
    mkdirSync(resolve(filePath, ".."), { recursive: true });
    writeFileSync(filePath, content, "utf8");
    return `Wrote ${content.length} bytes`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
function runEdit(path: string, oldText: string, newText: string) {
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

class EventBus {
  constructor(private eventLogPath: string) {
    mkdirSync(resolve(eventLogPath, ".."), { recursive: true });
    if (!existsSync(eventLogPath)) writeFileSync(eventLogPath, "", "utf8");
  }

  emit(event: string, task: Record<string, unknown> = {}, worktree: Record<string, unknown> = {}, error?: string) {
    const payload = { event, ts: Date.now() / 1000, task, worktree, ...(error ? { error } : {}) };
    appendFileSync(this.eventLogPath, `${JSON.stringify(payload)}\n`, "utf8");
  }

  listRecent(limit = 20) {
    const count = Math.max(1, Math.min(limit, 200));
    const lines = readFileSync(this.eventLogPath, "utf8").split(/\r?\n/).filter(Boolean).slice(-count);
    return JSON.stringify(lines.map((line) => JSON.parse(line)), null, 2);
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

  exists(taskId: number) {
    return existsSync(this.filePath(taskId));
  }

  private load(taskId: number): TaskRecord {
    if (!this.exists(taskId)) throw new Error(`Task ${taskId} not found`);
    return JSON.parse(readFileSync(this.filePath(taskId), "utf8")) as TaskRecord;
  }

  private save(task: TaskRecord) {
    writeFileSync(this.filePath(task.id), `${JSON.stringify(task, null, 2)}\n`, "utf8");
  }

  create(subject: string, description = "") {
    const task: TaskRecord = {
      id: this.nextId,
      subject,
      description,
      status: "pending",
      owner: "",
      worktree: "",
      blockedBy: [],
      created_at: Date.now() / 1000,
      updated_at: Date.now() / 1000,
    };
    this.save(task);
    this.nextId += 1;
    return JSON.stringify(task, null, 2);
  }

  get(taskId: number) {
    return JSON.stringify(this.load(taskId), null, 2);
  }

  update(taskId: number, status?: string, owner?: string) {
    const task = this.load(taskId);
    if (status) task.status = status as TaskStatus;
    if (typeof owner === "string") task.owner = owner;
    task.updated_at = Date.now() / 1000;
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  bindWorktree(taskId: number, worktree: string, owner = "") {
    const task = this.load(taskId);
    task.worktree = worktree;
    if (owner) task.owner = owner;
    if (task.status === "pending") task.status = "in_progress";
    task.updated_at = Date.now() / 1000;
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  unbindWorktree(taskId: number) {
    const task = this.load(taskId);
    task.worktree = "";
    task.updated_at = Date.now() / 1000;
    this.save(task);
    return JSON.stringify(task, null, 2);
  }
  listAll() {
    const tasks = readdirSync(this.tasksDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^task_\d+\.json$/.test(entry.name))
      .map((entry) => JSON.parse(readFileSync(resolve(this.tasksDir, entry.name), "utf8")) as TaskRecord)
      .sort((a, b) => a.id - b.id);
    if (!tasks.length) return "No tasks.";
    return tasks
      .map((task) => {
        const marker = { pending: "[ ]", in_progress: "[>]", completed: "[x]" }[task.status] ?? "[?]";
        const owner = task.owner ? ` owner=${task.owner}` : "";
        const wt = task.worktree ? ` wt=${task.worktree}` : "";
        return `${marker} #${task.id}: ${task.subject}${owner}${wt}`;
      })
      .join("\n");
  }
}

class WorktreeManager {
  constructor(private repoRoot: string, private tasks: TaskManager, private events: EventBus) {
    mkdirSync(WORKTREES_DIR, { recursive: true });
    if (!existsSync(INDEX_PATH)) writeFileSync(INDEX_PATH, `${JSON.stringify({ worktrees: [] }, null, 2)}\n`, "utf8");
  }

  get gitAvailable() {
    const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: this.repoRoot, encoding: "utf8", timeout: 10_000 });
    return result.status === 0;
  }

  private loadIndex(): { worktrees: WorktreeRecord[] } {
    return JSON.parse(readFileSync(INDEX_PATH, "utf8")) as { worktrees: WorktreeRecord[] };
  }

  private saveIndex(index: { worktrees: WorktreeRecord[] }) {
    writeFileSync(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  }

  private find(name: string) {
    return this.loadIndex().worktrees.find((worktree) => worktree.name === name);
  }

  create(name: string, taskId?: number, baseRef = "HEAD") {
    if (!this.gitAvailable) throw new Error("Not in a git repository. worktree tools require git.");
    if (this.find(name)) throw new Error(`Worktree '${name}' already exists`);
    if (taskId && !this.tasks.exists(taskId)) throw new Error(`Task ${taskId} not found`);
    const path = resolve(WORKTREES_DIR, name);
    const branch = `wt/${name}`;
    this.events.emit("worktree.create.before", taskId ? { id: taskId } : {}, { name, base_ref: baseRef });
    const result = spawnSync("git", ["worktree", "add", "-b", branch, path, baseRef], { cwd: this.repoRoot, encoding: "utf8", timeout: 120_000 });
    if (result.status !== 0) {
      const message = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() || "git worktree add failed";
      this.events.emit("worktree.create.failed", taskId ? { id: taskId } : {}, { name, base_ref: baseRef }, message);
      throw new Error(message);
    }
    const entry: WorktreeRecord = { name, path, branch, task_id: taskId, status: "active", created_at: Date.now() / 1000 };
    const index = this.loadIndex();
    index.worktrees.push(entry);
    this.saveIndex(index);
    if (taskId) this.tasks.bindWorktree(taskId, name);
    this.events.emit("worktree.create.after", taskId ? { id: taskId } : {}, { name, path, branch, status: "active" });
    return JSON.stringify(entry, null, 2);
  }

  listAll() {
    const worktrees = this.loadIndex().worktrees;
    if (!worktrees.length) return "No worktrees in index.";
    return worktrees.map((wt) => `[${wt.status}] ${wt.name} -> ${wt.path} (${wt.branch})${wt.task_id ? ` task=${wt.task_id}` : ""}`).join("\n");
  }

  status(name: string) {
    const wt = this.find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    return runCommand("git status --short --branch", wt.path, 60_000);
  }

  run(name: string, command: string) {
    const wt = this.find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    return runCommand(command, wt.path, 300_000);
  }

  keep(name: string) {
    const index = this.loadIndex();
    const worktree = index.worktrees.find((item) => item.name === name);
    if (!worktree) return `Error: Unknown worktree '${name}'`;
    worktree.status = "kept";
    worktree.kept_at = Date.now() / 1000;
    this.saveIndex(index);
    this.events.emit("worktree.keep", worktree.task_id ? { id: worktree.task_id } : {}, { name, path: worktree.path, status: "kept" });
    return JSON.stringify(worktree, null, 2);
  }

  remove(name: string, force = false, completeTask = false) {
    const worktree = this.find(name);
    if (!worktree) return `Error: Unknown worktree '${name}'`;
    this.events.emit("worktree.remove.before", worktree.task_id ? { id: worktree.task_id } : {}, { name, path: worktree.path });
    const args = ["worktree", "remove", ...(force ? ["--force"] : []), worktree.path];
    const result = spawnSync("git", args, { cwd: this.repoRoot, encoding: "utf8", timeout: 120_000 });
    if (result.status !== 0) {
      const message = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() || "git worktree remove failed";
      this.events.emit("worktree.remove.failed", worktree.task_id ? { id: worktree.task_id } : {}, { name, path: worktree.path }, message);
      throw new Error(message);
    }
    if (completeTask && worktree.task_id) {
      const before = JSON.parse(this.tasks.get(worktree.task_id)) as TaskRecord;
      this.tasks.update(worktree.task_id, "completed");
      this.tasks.unbindWorktree(worktree.task_id);
      this.events.emit("task.completed", { id: worktree.task_id, subject: before.subject, status: "completed" }, { name });
    }
    const index = this.loadIndex();
    const record = index.worktrees.find((item) => item.name === name);
    if (record) {
      record.status = "removed";
      record.removed_at = Date.now() / 1000;
    }
    this.saveIndex(index);
    this.events.emit("worktree.remove.after", worktree.task_id ? { id: worktree.task_id } : {}, { name, path: worktree.path, status: "removed" });
    return `Removed worktree '${name}'`;
  }
}

const EVENTS = new EventBus(EVENTS_PATH);
const TASKS = new TaskManager(TASKS_DIR);
const WORKTREES = new WorktreeManager(REPO_ROOT, TASKS, EVENTS);

const TOOL_HANDLERS: Record<ToolName, (input: Record<string, unknown>) => string> = {
  bash: (input) => runBash(String(input.command ?? "")),
  read_file: (input) => runRead(String(input.path ?? ""), Number(input.limit ?? 0) || undefined),
  write_file: (input) => runWrite(String(input.path ?? ""), String(input.content ?? "")),
  edit_file: (input) => runEdit(String(input.path ?? ""), String(input.old_text ?? ""), String(input.new_text ?? "")),
  task_create: (input) => TASKS.create(String(input.subject ?? ""), String(input.description ?? "")),
  task_list: () => TASKS.listAll(),
  task_get: (input) => TASKS.get(Number(input.task_id ?? 0)),
  task_update: (input) => TASKS.update(Number(input.task_id ?? 0), typeof input.status === "string" ? input.status : undefined, typeof input.owner === "string" ? input.owner : undefined),
  task_bind_worktree: (input) => TASKS.bindWorktree(Number(input.task_id ?? 0), String(input.worktree ?? ""), String(input.owner ?? "")),
  worktree_create: (input) => WORKTREES.create(String(input.name ?? ""), typeof input.task_id === "number" ? input.task_id : undefined, String(input.base_ref ?? "HEAD")),
  worktree_list: () => WORKTREES.listAll(),
  worktree_status: (input) => WORKTREES.status(String(input.name ?? "")),
  worktree_run: (input) => WORKTREES.run(String(input.name ?? ""), String(input.command ?? "")),
  worktree_keep: (input) => WORKTREES.keep(String(input.name ?? "")),
  worktree_remove: (input) => WORKTREES.remove(String(input.name ?? ""), Boolean(input.force), Boolean(input.complete_task)),
  worktree_events: (input) => EVENTS.listRecent(Number(input.limit ?? 20)),
};

const TOOLS = [
  { name: "bash", description: shellToolDescription(), input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "task_create", description: "Create a new task on the shared task board.", input_schema: { type: "object", properties: { subject: { type: "string" }, description: { type: "string" } }, required: ["subject"] } },
  { name: "task_list", description: "List all tasks.", input_schema: { type: "object", properties: {} } },
  { name: "task_get", description: "Get task details by ID.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
  { name: "task_update", description: "Update task status or owner.", input_schema: { type: "object", properties: { task_id: { type: "integer" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] }, owner: { type: "string" } }, required: ["task_id"] } },
  { name: "task_bind_worktree", description: "Bind a task to a worktree name.", input_schema: { type: "object", properties: { task_id: { type: "integer" }, worktree: { type: "string" }, owner: { type: "string" } }, required: ["task_id", "worktree"] } },
  { name: "worktree_create", description: "Create a git worktree and optionally bind it to a task.", input_schema: { type: "object", properties: { name: { type: "string" }, task_id: { type: "integer" }, base_ref: { type: "string" } }, required: ["name"] } },
  { name: "worktree_list", description: "List worktrees tracked in index.", input_schema: { type: "object", properties: {} } },
  { name: "worktree_status", description: "Show git status for one worktree.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "worktree_run", description: shellToolDescription("a named worktree"), input_schema: { type: "object", properties: { name: { type: "string" }, command: { type: "string" } }, required: ["name", "command"] } },
  { name: "worktree_remove", description: "Remove a worktree and optionally mark its task completed.", input_schema: { type: "object", properties: { name: { type: "string" }, force: { type: "boolean" }, complete_task: { type: "boolean" } }, required: ["name"] } },
  { name: "worktree_keep", description: "Mark a worktree as kept without removing it.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "worktree_events", description: "List recent worktree/task lifecycle events.", input_schema: { type: "object", properties: { limit: { type: "integer" } } } },
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
  console.log(`Repo root for s12: ${REPO_ROOT}`);
  if (!WORKTREES.gitAvailable) console.log("Note: Not in a git repo. worktree_* tools will return errors.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const history: Message[] = [];
  while (true) {
    let query = "";
    try {
      query = await rl.question("\x1b[36ms12 >> \x1b[0m");
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
