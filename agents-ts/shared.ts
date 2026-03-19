import Anthropic from "@anthropic-ai/sdk";
import process from "node:process";

export const DEFAULT_BASE_URL: string | undefined = undefined;
export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const SHELL_NAME = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
export const PLATFORM_LABEL = process.platform === "win32" ? "Windows" : "macOS/Linux";

export function platformGuidance(extra?: string): string {
  const lines = [
    `Runtime platform: ${PLATFORM_LABEL}. Shell commands run through ${SHELL_NAME}.`,
    "Prefer structured tools such as read_file, write_file, edit_file, task, and worktree tools over shell when possible.",
    "Do not use shell redirection, heredocs, node -e, or temporary script files for file edits when structured file tools are available.",
    "If you use shell, write commands for the current platform only.",
    "On Windows, do not assume Unix commands like ls, cat, grep, sleep, pwd, or shell redirection tricks will work.",
    "When possible, prefer Node.js and git commands that are portable across Windows and macOS.",
  ];

  if (extra) {
    lines.push(extra);
  }

  return lines.join("\n");
}

export function buildSystemPrompt(base: string, extra?: string): string {
  return `${base}\n\n${platformGuidance(extra)}`;
}

export function shellToolDescription(scope = "the current workspace"): string {
  return `Run a shell command in ${scope} using ${SHELL_NAME}. Commands must match the current platform; avoid Unix-only commands on Windows and avoid cmd.exe-only syntax on macOS/Linux.`;
}

export function resolveModel(): string {
  return (
    process.env.MODEL_ID ??
    process.env.ANTHROPIC_MODEL ??
    DEFAULT_MODEL
  );
}

export function resolveCredentials() {
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN ?? null;
  const apiKey = process.env.ANTHROPIC_API_KEY ?? null;

  if (!authToken && !apiKey) {
    throw new Error(
      "Missing API credential. Set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY."
    );
  }

  return { authToken, apiKey };
}

export function createAnthropicClient(): Anthropic {
  const { authToken, apiKey } = resolveCredentials();

  return new Anthropic({
    baseURL: process.env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE_URL,
    authToken,
    apiKey,
  });
}
