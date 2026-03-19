import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BASE_URL, DEFAULT_MODEL, resolveModel } from "./shared";

test("TypeScript agents default model matches the Python repo", () => {
  assert.equal(DEFAULT_MODEL, "claude-sonnet-4-6");
});

test("TypeScript agents do not hardcode a custom base URL by default", () => {
  assert.equal(DEFAULT_BASE_URL, undefined);
});

test("resolveModel falls back to the shared default model", () => {
  const previousModelId = process.env.MODEL_ID;
  const previousAnthropicModel = process.env.ANTHROPIC_MODEL;

  delete process.env.MODEL_ID;
  delete process.env.ANTHROPIC_MODEL;

  try {
    assert.equal(resolveModel(), "claude-sonnet-4-6");
  } finally {
    if (previousModelId === undefined) {
      delete process.env.MODEL_ID;
    } else {
      process.env.MODEL_ID = previousModelId;
    }

    if (previousAnthropicModel === undefined) {
      delete process.env.ANTHROPIC_MODEL;
    } else {
      process.env.ANTHROPIC_MODEL = previousAnthropicModel;
    }
  }
});
