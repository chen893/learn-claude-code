#!/usr/bin/env node
/**
 * s01_agent_loop.ts - The Agent Loop
 *
 * The entire secret of an AI coding agent in one pattern:
 *
 *   while (stopReason === "tool_use") {
 *     response = LLM(messages, tools)
 *     executeTools()
 *     appendResults()
 *   }
 */

import { spawnSync } from "node:child_process";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";
import { buildSystemPrompt, createAnthropicClient, resolveModel, shellToolDescription } from "./shared";

type ToolUseName = "bash";

type ToolUseBlock = {
  id: string;
  type: "tool_use";
  name: ToolUseName;
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

const SYSTEM = buildSystemPrompt(`You are a coding agent at ${WORKDIR}. Use bash to solve tasks. Act, don't explain.`);

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

const TOOL_HANDLERS: Record<ToolUseName, (input: Record<string, unknown>) => string> = {
  bash: (input) => runBash(String(input.command ?? "")),
};

const TOOLS = [
  {
    name: "bash",
    description: shellToolDescription(),
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
    },
  },
];

function assistantText(content: Array<ToolUseBlock | TextBlock | ToolResultBlock>) {
  return content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
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

      const handler = TOOL_HANDLERS[block.name as ToolUseName];
      const output = handler
        ? handler(block.input as Record<string, unknown>)
        : `Unknown tool: ${block.name}`;

      console.log(`> ${block.name}: ${output.slice(0, 200)}`);
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }

    messages.push({
      role: "user",
      content: results,
    });
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
      query = await rl.question("\x1b[36ms01 >> \x1b[0m");
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
