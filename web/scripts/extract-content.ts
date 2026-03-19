import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import type {
  AgentVersion,
  AgentLanguage,
  DocLanguage,
  VersionDiff,
  DocContent,
  VersionIndex,
} from "../src/types/agent-data";
import {
  VERSION_META,
  VERSION_ORDER,
  LEARNING_PATH,
  LEARNING_LANGUAGES,
} from "../src/lib/constants";

const WEB_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(WEB_DIR, "..");
const AGENTS_DIR = path.join(REPO_ROOT, "agents");
const TS_AGENTS_DIR = path.join(REPO_ROOT, "agents-ts");
const DOCS_DIR = path.join(REPO_ROOT, "docs");
const OUT_DIR = path.join(WEB_DIR, "src", "data", "generated");

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

function filenameToVersionId(filename: string): string | null {
  const base = path.basename(filename, path.extname(filename));
  if (base === "s_full") return null;
  if (base === "__init__") return null;

  const match = base.match(/^(s\d+[a-c]?)_/);
  return match ? match[1] : null;
}

function extractPythonClasses(
  lines: string[]
): { name: string; startLine: number; endLine: number }[] {
  const classes: { name: string; startLine: number; endLine: number }[] = [];
  const classPattern = /^class\s+(\w+)/;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(classPattern);
    if (!match) continue;

    let endLine = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (
        lines[j].match(/^class\s/) ||
        lines[j].match(/^def\s/) ||
        (lines[j].match(/^\S/) &&
          lines[j].trim() !== "" &&
          !lines[j].startsWith("#") &&
          !lines[j].startsWith("@"))
      ) {
        endLine = j;
        break;
      }
    }

    classes.push({
      name: match[1],
      startLine: i + 1,
      endLine,
    });
  }

  return classes;
}

function extractTypeScriptClasses(
  lines: string[]
): { name: string; startLine: number; endLine: number }[] {
  const classes: { name: string; startLine: number; endLine: number }[] = [];
  const classPattern = /^\s*(?:export\s+)?class\s+(\w+)/;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(classPattern);
    if (!match) continue;

    let braceDepth = 0;
    let started = false;
    let endLine = lines.length;

    for (let j = i; j < lines.length; j++) {
      const line = lines[j];
      for (const char of line) {
        if (char === "{") {
          braceDepth += 1;
          started = true;
        } else if (char === "}") {
          braceDepth -= 1;
          if (started && braceDepth === 0) {
            endLine = j + 1;
            break;
          }
        }
      }
      if (endLine !== lines.length) break;
    }

    classes.push({
      name: match[1],
      startLine: i + 1,
      endLine,
    });
  }

  return classes;
}

function extractClasses(
  lines: string[],
  language: AgentLanguage
): { name: string; startLine: number; endLine: number }[] {
  return language === "ts"
    ? extractTypeScriptClasses(lines)
    : extractPythonClasses(lines);
}

function extractPythonFunctions(
  lines: string[]
): { name: string; signature: string; startLine: number }[] {
  const functions: { name: string; signature: string; startLine: number }[] = [];
  const funcPattern = /^def\s+(\w+)\((.*?)\)/;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(funcPattern);
    if (!match) continue;

    functions.push({
      name: match[1],
      signature: `def ${match[1]}(${match[2]})`,
      startLine: i + 1,
    });
  }

  return functions;
}

function extractTypeScriptFunctions(
  lines: string[]
): { name: string; signature: string; startLine: number }[] {
  const functions: { name: string; signature: string; startLine: number }[] = [];
  const patterns = [
    {
      pattern: /^\s*(?:export\s+)?async\s+function\s+(\w+)\((.*?)\)/,
      signature: (name: string, args: string) => `async function ${name}(${args})`,
    },
    {
      pattern: /^\s*(?:export\s+)?function\s+(\w+)\((.*?)\)/,
      signature: (name: string, args: string) => `function ${name}(${args})`,
    },
    {
      pattern: /^\s*const\s+(\w+)\s*=\s*(?:async\s*)?\((.*?)\)\s*=>/,
      signature: (name: string, args: string) => `const ${name} = (${args}) =>`,
    },
  ];

  for (let i = 0; i < lines.length; i++) {
    for (const entry of patterns) {
      const match = lines[i].match(entry.pattern);
      if (!match) continue;

      functions.push({
        name: match[1],
        signature: entry.signature(match[1], match[2]),
        startLine: i + 1,
      });
      break;
    }
  }

  return functions;
}

function extractFunctions(
  lines: string[],
  language: AgentLanguage
): { name: string; signature: string; startLine: number }[] {
  return language === "ts"
    ? extractTypeScriptFunctions(lines)
    : extractPythonFunctions(lines);
}

export function extractTools(source: string): string[] {
  const toolPattern =
    /\{\s*(?:"name"|name)\s*:\s*"([^"]+)"\s*,\s*(?:"description"|description)\s*:/gms;
  const tools = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = toolPattern.exec(source)) !== null) {
    tools.add(match[1]);
  }

  return Array.from(tools);
}

function countLoc(lines: string[]): number {
  return lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !trimmed.startsWith("#") && !trimmed.startsWith("//");
  }).length;
}

function extractDocVersion(filename: string): string | null {
  const match = filename.match(/^(s\d+[a-c]?)-/);
  return match ? match[1] : null;
}

function getAgentFiles(): { filePath: string; filename: string; language: AgentLanguage }[] {
  const files: { filePath: string; filename: string; language: AgentLanguage }[] = [];

  for (const entry of fs.readdirSync(AGENTS_DIR, { withFileTypes: true })) {
    const entryPath = path.join(AGENTS_DIR, entry.name);

    if (entry.isFile() && entry.name.startsWith("s") && entry.name.endsWith(".py")) {
      files.push({ filePath: entryPath, filename: entry.name, language: "python" });
      continue;
    }
  }

  if (fs.existsSync(TS_AGENTS_DIR)) {
    for (const filename of fs.readdirSync(TS_AGENTS_DIR)) {
      if (!filename.startsWith("s")) continue;
      if (filename === "shared.ts") continue;
      if (!filename.endsWith(".ts")) continue;
      files.push({
        filePath: path.join(TS_AGENTS_DIR, filename),
        filename,
        language: "ts",
      });
    }
  }

  return files;
}

function readDocs(): DocContent[] {
  const docs: DocContent[] = [];

  if (!fs.existsSync(DOCS_DIR)) {
    console.warn(`  Docs directory not found: ${DOCS_DIR}`);
    return docs;
  }

  const localeDirs = ["en", "zh", "ja"] as const;
  let totalDocFiles = 0;

  for (const locale of localeDirs) {
    const localeDir = path.join(DOCS_DIR, locale);
    if (!fs.existsSync(localeDir)) continue;

    for (const entry of fs.readdirSync(localeDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        totalDocFiles += 1;
        const version = extractDocVersion(entry.name);
        if (!version) continue;

        const content = normalizeLineEndings(fs.readFileSync(path.join(localeDir, entry.name), "utf-8"));
        const titleMatch = content.match(/^#\s+(.+)$/m);

        docs.push({
          language: "shared" as DocLanguage,
          version,
          locale,
          title: titleMatch ? titleMatch[1] : entry.name,
          content,
        });
      }

      if (!entry.isDirectory()) continue;
      if (!LEARNING_LANGUAGES.includes(entry.name as AgentLanguage)) continue;

      const language = entry.name as AgentLanguage;
      const languageDir = path.join(localeDir, entry.name);

      for (const filename of fs.readdirSync(languageDir)) {
        if (!filename.endsWith(".md")) continue;
        totalDocFiles += 1;

        const version = extractDocVersion(filename);
        if (!version) continue;

        const content = normalizeLineEndings(fs.readFileSync(path.join(languageDir, filename), "utf-8"));
        const titleMatch = content.match(/^#\s+(.+)$/m);

        docs.push({
          language,
          version,
          locale,
          title: titleMatch ? titleMatch[1] : filename,
          content,
        });
      }
    }
  }

  console.log(`  Found ${totalDocFiles} doc files across ${localeDirs.length} locales`);
  return docs;
}

export function main() {
  console.log("Extracting content from agents and docs...");
  console.log(`  Repo root: ${REPO_ROOT}`);
  console.log(`  Agents dir: ${AGENTS_DIR}`);
  console.log(`  Docs dir: ${DOCS_DIR}`);

  if (!fs.existsSync(AGENTS_DIR)) {
    console.log("  Agents directory not found, skipping extraction.");
    console.log("  Using pre-committed generated data.");
    return;
  }

  const agentFiles = getAgentFiles();
  console.log(`  Found ${agentFiles.length} agent files`);

  const versions: AgentVersion[] = [];

  for (const agentFile of agentFiles) {
    const versionId = filenameToVersionId(agentFile.filename);
    if (!versionId) {
      console.warn(`  Skipping ${agentFile.filename}: could not determine version ID`);
      continue;
    }

    const source = normalizeLineEndings(fs.readFileSync(agentFile.filePath, "utf-8"));
    const lines = source.split("\n");
    const meta = VERSION_META[versionId];

    versions.push({
      language: agentFile.language,
      id: versionId,
      filename: agentFile.filename,
      title: meta?.title ?? versionId,
      subtitle: meta?.subtitle ?? "",
      loc: countLoc(lines),
      tools: extractTools(source),
      newTools: [],
      coreAddition: meta?.coreAddition ?? "",
      keyInsight: meta?.keyInsight ?? "",
      classes: extractClasses(lines, agentFile.language),
      functions: extractFunctions(lines, agentFile.language),
      layer: meta?.layer ?? "tools",
      source,
    });
  }

  const languageOrder = new Map(LEARNING_LANGUAGES.map((language, index) => [language, index]));
  const versionOrder = new Map(VERSION_ORDER.map((version, index) => [version, index]));

  versions.sort(
    (a, b) =>
      (languageOrder.get(a.language) ?? 99) - (languageOrder.get(b.language) ?? 99) ||
      (versionOrder.get(a.id as (typeof VERSION_ORDER)[number]) ?? 99) -
        (versionOrder.get(b.id as (typeof VERSION_ORDER)[number]) ?? 99)
  );

  for (const language of LEARNING_LANGUAGES) {
    const scopedVersions = versions.filter((version) => version.language === language);
    for (let i = 0; i < scopedVersions.length; i++) {
      const prevTools = i > 0 ? new Set(scopedVersions[i - 1].tools) : new Set<string>();
      scopedVersions[i].newTools = scopedVersions[i].tools.filter((tool) => !prevTools.has(tool));
    }
  }

  const diffs: VersionDiff[] = [];
  const versionMap = new Map(versions.map((version) => [`${version.language}:${version.id}`, version]));

  for (const language of LEARNING_LANGUAGES) {
    for (let i = 1; i < LEARNING_PATH.length; i++) {
      const fromId = LEARNING_PATH[i - 1];
      const toId = LEARNING_PATH[i];
      const fromVer = versionMap.get(`${language}:${fromId}`);
      const toVer = versionMap.get(`${language}:${toId}`);

      if (!fromVer || !toVer) continue;

      const fromClassNames = new Set(fromVer.classes.map((item) => item.name));
      const fromFunctionNames = new Set(fromVer.functions.map((item) => item.name));
      const fromToolNames = new Set(fromVer.tools);

      diffs.push({
        language,
        from: fromId,
        to: toId,
        newClasses: toVer.classes
          .map((item) => item.name)
          .filter((name) => !fromClassNames.has(name)),
        newFunctions: toVer.functions
          .map((item) => item.name)
          .filter((name) => !fromFunctionNames.has(name)),
        newTools: toVer.tools.filter((tool) => !fromToolNames.has(tool)),
        locDelta: toVer.loc - fromVer.loc,
      });
    }
  }

  const docs = readDocs();

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const index: VersionIndex = { versions, diffs };
  fs.writeFileSync(path.join(OUT_DIR, "versions.json"), JSON.stringify(index, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "docs.json"), JSON.stringify(docs, null, 2));

  console.log("\nExtraction complete:");
  console.log(`  ${versions.length} versions`);
  console.log(`  ${diffs.length} diffs`);
  console.log(`  ${docs.length} docs`);
  for (const version of versions) {
    console.log(
      `    ${version.language}/${version.id}: ${version.loc} LOC, ${version.tools.length} tools, ${version.classes.length} classes, ${version.functions.length} functions`
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
