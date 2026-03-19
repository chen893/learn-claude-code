#!/usr/bin/env node
/**
 * s05_skill_loading.ts - Skills
 *
 * Two-layer skill injection:
 * 1. Keep lightweight skill metadata in the system prompt.
 * 2. Load the full SKILL.md body only when the model asks for it.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";
import { buildSystemPrompt, createAnthropicClient, resolveModel, shellToolDescription } from "./shared";

type ToolName = "bash" | "read_file" | "write_file" | "edit_file" | "load_skill";

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

type MessageContent = string | Array<ToolUseBlock | TextBlock | ToolResultBlock>;

type Message = {
  role: "user" | "assistant";
  content: MessageContent;
};

type SkillRecord = {
  meta: Record<string, string>;
  body: string;
  path: string;
};

const WORKDIR = process.cwd();
const MODEL = resolveModel();
const SKILLS_DIR = resolve(WORKDIR, "..", "skills");
const client = createAnthropicClient();

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

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/m.exec(text);
  if (!match) {
    return { meta: {}, body: text.trim() };
  }

  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) meta[key] = value;
  }

  return { meta, body: match[2].trim() };
}

function collectSkillFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }

  const files: string[] = [];
  const stack = [dir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    for (const entry of readdirSync(current)) {
      const entryPath = resolve(current, entry);
      const stats = statSync(entryPath);
      if (stats.isDirectory()) {
        stack.push(entryPath);
        continue;
      }

      if (stats.isFile() && entry === "SKILL.md") {
        files.push(entryPath);
      }
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

class SkillLoader {
  skills: Record<string, SkillRecord> = {};

  constructor(private skillsDir: string) {
    this.loadAll();
  }

  private loadAll() {
    for (const filePath of collectSkillFiles(this.skillsDir)) {
      const text = readFileSync(filePath, "utf8");
      const { meta, body } = parseFrontmatter(text);
      const normalized = filePath.replace(/\\/g, "/");
      const fallbackName = normalized.split("/").slice(-2, -1)[0] ?? "unknown";
      const name = meta.name || fallbackName;
      this.skills[name] = { meta, body, path: filePath };
    }
  }

  getDescriptions(): string {
    const entries = Object.entries(this.skills);
    if (entries.length === 0) {
      return "(no skills available)";
    }

    return entries
      .map(([name, skill]) => {
        const desc = skill.meta.description || "No description";
        const tags = skill.meta.tags ? ` [${skill.meta.tags}]` : "";
        return `  - ${name}: ${desc}${tags}`;
      })
      .join("\n");
  }

  getContent(name: string): string {
    const skill = this.skills[name];
    if (!skill) {
      const names = Object.keys(this.skills).join(", ");
      return `Error: Unknown skill '${name}'. Available: ${names}`;
    }
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}

const skillLoader = new SkillLoader(SKILLS_DIR);

const SYSTEM = buildSystemPrompt(`You are a coding agent at ${WORKDIR}.
Use load_skill to access specialized knowledge before tackling unfamiliar topics.

Skills available:
${skillLoader.getDescriptions()}`);

const TOOL_HANDLERS: Record<ToolName, (input: Record<string, unknown>) => string> = {
  bash: (input) => runBash(String(input.command ?? "")),
  read_file: (input) => runRead(String(input.path ?? ""), Number(input.limit ?? 0) || undefined),
  write_file: (input) => runWrite(String(input.path ?? ""), String(input.content ?? "")),
  edit_file: (input) =>
    runEdit(String(input.path ?? ""), String(input.old_text ?? ""), String(input.new_text ?? "")),
  load_skill: (input) => skillLoader.getContent(String(input.name ?? "")),
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
    name: "load_skill",
    description: "Load specialized knowledge by name.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name to load" },
      },
      required: ["name"],
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

      const handler = TOOL_HANDLERS[block.name as ToolName];
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
      query = await rl.question("\x1b[36ms05 >> \x1b[0m");
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
