import test from "node:test";
import assert from "node:assert/strict";
import { extractTools } from "./extract-content";

test("extractTools only returns tool definition names", () => {
  const source = `
type TeamMember = { name: string; role: string };
type TeamConfig = { team_name: string; members: TeamMember[] };

const TOOLS = [
  { name: "bash", description: "Run shell commands.", input_schema: { type: "object" } },
  { name: "spawn_teammate", description: "Spawn a teammate.", input_schema: { type: "object" } },
];

const fallback = { team_name: "default", members: [] };
`;

  assert.deepEqual(extractTools(source), ["bash", "spawn_teammate"]);
});

test("extractTools supports python-style quoted keys without matching config names", () => {
  const source = `
TEAM_CONFIG = {"team_name": "default", "members": [{"name": "alice"}]}

TOOLS = [
  {"name": "bash", "description": "Run a shell command.", "input_schema": {"type": "object"}},
  {"name": "read_file", "description": "Read file contents.", "input_schema": {"type": "object"}},
]
`;

  assert.deepEqual(extractTools(source), ["bash", "read_file"]);
});
