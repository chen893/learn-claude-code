#!/usr/bin/env node
/**
 * s06_context_compact.ts - Compact
 *
 * Three-layer compression pipeline:
 * 1. Micro-compact old tool results before each model call.
 * 2. Auto-compact when the token estimate crosses a threshold.
 * 3. Expose a compact tool for manual summarization.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";
import { buildSystemPrompt, createAnthropicClient, resolveModel, shellToolDescription } from "./shared";

type ToolName = "bash" | "read_file" | "write_file" | "edit_file" | "compact";

type ToolUseBlock = {
  id: string;
  type: "tool_use";
  name: ToolName;
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

type AssistantBlock = ToolUseBlock | TextBlock;
type MessageContent = string | Array<AssistantBlock | ToolResultBlock>;

type Message = {
  role: "user" | "assistant";
  content: MessageContent;
};

const WORKDIR = process.cwd();
const MODEL = resolveModel();
const THRESHOLD = 50_000;
const KEEP_RECENT = 3;
const TRANSCRIPT_DIR = resolve(WORKDIR, ".transcripts");
const client = createAnthropicClient();

const SYSTEM = buildSystemPrompt(`You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`);

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

function estimateTokens(messages: Message[]): number {
  return JSON.stringify(messages).length / 4;
}

function isToolResultBlock(block: unknown): block is ToolResultBlock {
  return !!block
    && typeof block === "object"
    && "type" in block
    && (block as { type?: string }).type === "tool_result";
}

function isToolUseBlock(block: unknown): block is ToolUseBlock {
  return !!block
    && typeof block === "object"
    && "type" in block
    && (block as { type?: string }).type === "tool_use";
}

function microCompact(messages: Message[]): Message[] {
  const toolResults: ToolResultBlock[] = [];

  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (isToolResultBlock(part)) {
        toolResults.push(part);
      }
    }
  }

  if (toolResults.length <= KEEP_RECENT) {
    return messages;
  }

  const toolNameMap: Record<string, string> = {};
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isToolUseBlock(block)) {
        toolNameMap[block.id] = block.name;
      }
    }
  }

  for (const result of toolResults.slice(0, -KEEP_RECENT)) {
    if (result.content.length <= 100) continue;
    const toolName = toolNameMap[result.tool_use_id] ?? "unknown";
    result.content = `[Previous: used ${toolName}]`;
  }

  return messages;
}

async function autoCompact(messages: Message[]): Promise<Message[]> {
  if (!existsSync(TRANSCRIPT_DIR)) {
    mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  }

  const transcriptPath = resolve(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  for (const message of messages) {
    appendFileSync(transcriptPath, `${JSON.stringify(message)}\n`, "utf8");
  }
  console.log(`[transcript saved: ${transcriptPath}]`);

  const conversationText = JSON.stringify(messages).slice(0, 80_000);
  const response = await client.messages.create({
    model: MODEL,
    messages: [{
      role: "user",
      content:
        "Summarize this conversation for continuity. Include: " +
        "1) What was accomplished, 2) Current state, 3) Key decisions made. " +
        `Be concise but preserve critical details.\n\n${conversationText}`,
    }],
    max_tokens: 2000,
  });

  const summaryParts: string[] = [];
  for (const block of response.content) {
    if (block.type === "text") summaryParts.push(block.text);
  }
  const summary = summaryParts.join("") || "(no summary)";

  return [
    {
      role: "user",
      content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}`,
    },
    {
      role: "assistant",
      content: "Understood. I have the context from the summary. Continuing.",
    },
  ];
}

const TOOL_HANDLERS: Record<Exclude<ToolName, "compact">, (input: Record<string, unknown>) => string> = {
  bash: (input) => runBash(String(input.command ?? "")),
  read_file: (input) => runRead(String(input.path ?? ""), Number(input.limit ?? 0) || undefined),
  write_file: (input) => runWrite(String(input.path ?? ""), String(input.content ?? "")),
  edit_file: (input) =>
    runEdit(String(input.path ?? ""), String(input.old_text ?? ""), String(input.new_text ?? "")),
};

const TOOLS = [
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
  {
    name: "compact",
    description: "Trigger manual conversation compression.",
    input_schema: {
      type: "object",
      properties: {
        focus: { type: "string", description: "What to preserve in the summary" },
      },
    },
  },
];

function assistantText(content: AssistantBlock[]) {
  return content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export async function agentLoop(messages: Message[]) {
  while (true) {
    microCompact(messages);

    if (estimateTokens(messages) > THRESHOLD) {
      console.log("[auto_compact triggered]");
      messages.splice(0, messages.length, ...(await autoCompact(messages)));
    }

    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages: messages as Anthropic.Messages.MessageParam[],
      tools: TOOLS as Anthropic.Messages.Tool[],
      max_tokens: 8000,
    });

    messages.push({
      role: "assistant",
      content: response.content as AssistantBlock[],
    });

    if (response.stop_reason !== "tool_use") {
      return;
    }

    let manualCompact = false;
    const results: ToolResultBlock[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      let output: string;
      if (block.name === "compact") {
        manualCompact = true;
        output = "Compressing...";
      } else {
        const handler = TOOL_HANDLERS[block.name as Exclude<ToolName, "compact">];
        output = handler
          ? handler(block.input as Record<string, unknown>)
          : `Unknown tool: ${block.name}`;
      }

      console.log(`> ${block.name}: ${output.slice(0, 200)}`);
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }

    messages.push({ role: "user", content: results });

    if (manualCompact) {
      console.log("[manual compact]");
      messages.splice(0, messages.length, ...(await autoCompact(messages)));
    }
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
      query = await rl.question("\x1b[36ms06 >> \x1b[0m");
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
      const text = assistantText(last as AssistantBlock[]);
      if (text) console.log(text);
    }
    console.log();
  }

  rl.close();
}

void main();
