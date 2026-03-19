#!/usr/bin/env node
/**
 * s04_subagent.ts - Subagents
 *
 * Spawn a child agent with fresh messages=[].
 * The child shares the filesystem, but returns only a short summary.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";
import { buildSystemPrompt, createAnthropicClient, resolveModel, shellToolDescription } from "./shared";

type BaseToolName = "bash" | "read_file" | "write_file" | "edit_file";
type ParentToolName = BaseToolName | "task";

type ToolUseBlock = {
  id: string;
  type: "tool_use";
  name: ParentToolName;
  input: Record<string, unknown>;
};

type TextBlock = {
  type: "text";
  text: string;
};

type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
};

type MessageContent = string | Array<ToolUseBlock | TextBlock | ToolResultBlock>;

type Message = {
  role: "user" | "assistant";
  content: MessageContent;
};

const WORKDIR = process.cwd();
const MODEL = resolveModel();
const client = createAnthropicClient();

const SYSTEM = buildSystemPrompt(`You are a coding agent at ${WORKDIR}. Use the task tool to delegate exploration or subtasks.`);
const SUBAGENT_SYSTEM = buildSystemPrompt(`You are a coding subagent at ${WORKDIR}. Complete the given task, then summarize your findings.`);

function safePath(relativePath: string): string {
  const filePath = resolve(WORKDIR, relativePath);
  const normalizedWorkdir = `${WORKDIR}${process.platform === "win32" ? "\\" : "/"}`;
  if (filePath !== WORKDIR && !filePath.startsWith(normalizedWorkdir)) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }
  return filePath;
}

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((item) => command.includes(item))) {
    return "Error: Dangerous command blocked";
  }

  const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", command]
    : ["-lc", command];

  const result = spawnSync(shell, args, {
    cwd: WORKDIR,
    encoding: "utf8",
    timeout: 120_000,
  });

  if (result.error?.name === "TimeoutError") {
    return "Error: Timeout (120s)";
  }

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return output.slice(0, 50_000) || "(no output)";
}

function runRead(path: string, limit?: number): string {
  try {
    let lines = readFileSync(safePath(path), "utf8").split(/\r?\n/);
    if (limit && limit < lines.length) {
      lines = lines.slice(0, limit).concat(`... (${lines.length - limit} more)`);
    }
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
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${path}`;
    }
    writeFileSync(filePath, content.replace(oldText, newText), "utf8");
    return `Edited ${path}`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const TOOL_HANDLERS: Record<BaseToolName, (input: Record<string, unknown>) => string> = {
  bash: (input) => runBash(String(input.command ?? "")),
  read_file: (input) => runRead(String(input.path ?? ""), Number(input.limit ?? 0) || undefined),
  write_file: (input) => runWrite(String(input.path ?? ""), String(input.content ?? "")),
  edit_file: (input) =>
    runEdit(String(input.path ?? ""), String(input.old_text ?? ""), String(input.new_text ?? "")),
};

const CHILD_TOOLS = [
  {
    name: "bash",
    description: shellToolDescription(),
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "integer" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text in file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
];

const PARENT_TOOLS = [
  ...CHILD_TOOLS,
  {
    name: "task",
    description: "Spawn a subagent with fresh context. It shares the filesystem but not conversation history.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        description: { type: "string" },
      },
      required: ["prompt"],
    },
  },
];

function assistantText(content: Array<ToolUseBlock | TextBlock | ToolResultBlock>) {
  return content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function runSubagent(prompt: string): Promise<string> {
  const subMessages: Message[] = [{ role: "user", content: prompt }];
  let response: Anthropic.Messages.Message | null = null;

  for (let attempt = 0; attempt < 30; attempt += 1) {
    response = await client.messages.create({
      model: MODEL,
      system: SUBAGENT_SYSTEM,
      messages: subMessages as Anthropic.Messages.MessageParam[],
      tools: CHILD_TOOLS as Anthropic.Messages.Tool[],
      max_tokens: 8000,
    });

    subMessages.push({
      role: "assistant",
      content: response.content as Array<ToolUseBlock | TextBlock>,
    });

    if (response.stop_reason !== "tool_use") {
      break;
    }

    const results: ToolResultBlock[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use" || block.name === "task") continue;
      const handler = TOOL_HANDLERS[block.name as BaseToolName];
      const output = handler
        ? handler(block.input as Record<string, unknown>)
        : `Unknown tool: ${block.name}`;
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: String(output).slice(0, 50_000),
      });
    }

    subMessages.push({ role: "user", content: results });
  }

  if (!response) return "(no summary)";
  const texts: string[] = [];
  for (const block of response.content) {
    if (block.type === "text") texts.push(block.text);
  }
  return texts.join("") || "(no summary)";
}

export async function agentLoop(messages: Message[]) {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages: messages as Anthropic.Messages.MessageParam[],
      tools: PARENT_TOOLS as Anthropic.Messages.Tool[],
      max_tokens: 8000,
    });

    messages.push({
      role: "assistant",
      content: response.content as Array<ToolUseBlock | TextBlock>,
    });

    if (response.stop_reason !== "tool_use") {
      return;
    }

    const results: ToolResultBlock[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      let output: string;
      if (block.name === "task") {
        const input = block.input as { description?: string; prompt?: string };
        const description = String(input.description ?? "subtask");
        console.log(`> task (${description}): ${String(input.prompt ?? "").slice(0, 80)}`);
        output = await runSubagent(String(input.prompt ?? ""));
      } else {
        const handler = TOOL_HANDLERS[block.name as BaseToolName];
        output = handler
          ? handler(block.input as Record<string, unknown>)
          : `Unknown tool: ${block.name}`;
      }

      console.log(`  ${output.slice(0, 200)}`);
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }

    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const history: Message[] = [];

  while (true) {
    let query = "";
    try {
      query = await rl.question("\x1b[36ms04 >> \x1b[0m");
    } catch (error) {
      if (
        error instanceof Error &&
        (("code" in error && error.code === "ERR_USE_AFTER_CLOSE") || error.name === "AbortError")
      ) {
        break;
      }
      throw error;
    }
    if (!query.trim() || ["q", "exit"].includes(query.trim().toLowerCase())) {
      break;
    }

    history.push({ role: "user", content: query });
    await agentLoop(history);

    const last = history[history.length - 1]?.content;
    if (Array.isArray(last)) {
      const text = assistantText(last);
      if (text) console.log(text);
    }
    console.log();
  }

  rl.close();
}

void main();
