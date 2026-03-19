import test from "node:test";
import assert from "node:assert/strict";
import {
  getCorePatternExample,
  getLanguageFromPathname,
  getPathLanguageFromPathname,
  getPathnameForLanguage,
  resolveActiveLanguage,
} from "./learning";

function flattenExample(example: ReturnType<typeof getCorePatternExample>) {
  return example.lines.map((line) => line.map((token) => token.text).join("")).join("\n");
}

test("getPathnameForLanguage rewrites detail page language segment", () => {
  assert.equal(getPathnameForLanguage("/zh/ts/s09", "python"), "/zh/python/s09");
});

test("getPathnameForLanguage rewrites diff page language segment", () => {
  assert.equal(getPathnameForLanguage("/en/python/s10/diff", "ts"), "/en/ts/s10/diff");
});

test("getPathnameForLanguage keeps non-language routes unchanged", () => {
  assert.equal(getPathnameForLanguage("/ja/timeline", "ts"), "/ja/timeline");
});

test("getLanguageFromPathname reads the language segment from detail routes", () => {
  assert.equal(getLanguageFromPathname("/en/ts/s01"), "ts");
});

test("getPathLanguageFromPathname returns null for non-language routes", () => {
  assert.equal(getPathLanguageFromPathname("/en/timeline"), null);
});

test("getLanguageFromPathname falls back to default for non-language routes", () => {
  assert.equal(getLanguageFromPathname("/en/timeline"), "python");
});

test("resolveActiveLanguage prefers browser pathname when current pathname omits the language segment", () => {
  assert.equal(resolveActiveLanguage("/en/s01/", "/en/ts/s01/", "python"), "ts");
});
test("getCorePatternExample returns python homepage sample", () => {
  const sample = getCorePatternExample("python");
  assert.equal(sample.filename, "agent_loop.py");
  assert.match(flattenExample(sample), /while True:/);
  assert.equal(sample.lines[0][0]?.className, "text-purple-400");
});

test("getCorePatternExample returns typescript homepage sample", () => {
  const sample = getCorePatternExample("ts");
  assert.equal(sample.filename, "s01_agent_loop.ts");
  assert.match(flattenExample(sample), /while \(true\)/);
  assert.equal(sample.lines[1][0]?.className, "text-purple-400");
});
