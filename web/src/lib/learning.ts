import docsData from "@/data/generated/docs.json";
import versionsData from "@/data/generated/versions.json";
import { LEARNING_LANGUAGES, LEARNING_PATH, VERSION_META, type LearningLanguage, type VersionId } from "@/lib/constants";
import type { AgentVersion, DocContent, VersionDiff, VersionIndex } from "@/types/agent-data";

export const DEFAULT_LANGUAGE: LearningLanguage = "python";

type CorePatternToken = {
  text: string;
  className: string;
};

type CorePatternExample = {
  filename: string;
  lines: CorePatternToken[][];
};

const CORE_PATTERN_EXAMPLES: Record<LearningLanguage, CorePatternExample> = {
  python: {
    filename: "agent_loop.py",
    lines: [
      [
        { text: "while", className: "text-purple-400" },
        { text: " ", className: "text-zinc-300" },
        { text: "True", className: "text-orange-300" },
        { text: ":", className: "text-zinc-500" },
      ],
      [
        { text: "    response = client.messages.", className: "text-zinc-300" },
        { text: "create", className: "text-blue-400" },
        { text: "(", className: "text-zinc-500" },
        { text: "messages=messages, tools=tools", className: "text-zinc-300" },
        { text: ")", className: "text-zinc-500" },
      ],
      [
        { text: "    if", className: "text-purple-400" },
        { text: " response.stop_reason != ", className: "text-zinc-300" },
        { text: '"tool_use"', className: "text-green-400" },
        { text: ":", className: "text-zinc-500" },
      ],
      [{ text: "        break", className: "text-purple-400" }],
      [
        { text: "    for", className: "text-purple-400" },
        { text: " tool_call ", className: "text-zinc-300" },
        { text: "in", className: "text-purple-400" },
        { text: " response.content", className: "text-zinc-300" },
        { text: ":", className: "text-zinc-500" },
      ],
      [
        {
          text: "        result = execute_tool(tool_call.name, tool_call.input)",
          className: "text-zinc-300",
        },
      ],
      [{ text: "        messages.append(result)", className: "text-zinc-300" }],
    ],
  },
  ts: {
    filename: "s01_agent_loop.ts",
    lines: [
      [
        { text: "while", className: "text-purple-400" },
        { text: " ", className: "text-zinc-300" },
        { text: "(", className: "text-zinc-500" },
        { text: "true", className: "text-orange-300" },
        { text: ") {", className: "text-zinc-500" },
      ],
      [
        { text: "  const", className: "text-purple-400" },
        { text: " response = ", className: "text-zinc-300" },
        { text: "await", className: "text-purple-400" },
        { text: " client.messages.", className: "text-zinc-300" },
        { text: "create", className: "text-blue-400" },
        { text: "({ messages, tools });", className: "text-zinc-500" },
      ],
      [
        { text: "  if", className: "text-purple-400" },
        { text: " (response.stop_reason !== ", className: "text-zinc-300" },
        { text: '"tool_use"', className: "text-green-400" },
        { text: ") {", className: "text-zinc-500" },
      ],
      [{ text: "    break;", className: "text-purple-400" }],
      [{ text: "  }", className: "text-zinc-500" }],
      [
        { text: "  for", className: "text-purple-400" },
        { text: " (", className: "text-zinc-500" },
        { text: "const", className: "text-purple-400" },
        { text: " toolCall ", className: "text-zinc-300" },
        { text: "of", className: "text-purple-400" },
        { text: " response.content) {", className: "text-zinc-300" },
      ],
      [
        { text: "    const", className: "text-purple-400" },
        { text: " result = ", className: "text-zinc-300" },
        { text: "await", className: "text-purple-400" },
        { text: " executeTool(toolCall.name, toolCall.input);", className: "text-zinc-300" },
      ],
      [{ text: "    messages.push(result);", className: "text-zinc-300" }],
      [{ text: "  }", className: "text-zinc-500" }],
      [{ text: "}", className: "text-zinc-500" }],
    ],
  },
};

export const LANGUAGE_LABELS: Record<LearningLanguage, string> = {
  python: "Python",
  ts: "TypeScript",
};

const versionIndex = versionsData as VersionIndex;
const docsIndex = docsData as DocContent[];

function normalizeLanguage(language?: string): LearningLanguage {
  return LEARNING_LANGUAGES.includes(language as LearningLanguage)
    ? (language as LearningLanguage)
    : DEFAULT_LANGUAGE;
}

export function getPathLanguageFromPathname(pathname: string | null): LearningLanguage | null {
  if (!pathname) return null;
  const segments = pathname.split("/").filter(Boolean);
  const candidate = segments[1];
  return LEARNING_LANGUAGES.includes(candidate as LearningLanguage)
    ? (candidate as LearningLanguage)
    : null;
}

export function getLearningPath(): readonly VersionId[] {
  return LEARNING_PATH;
}

export function getVersionMeta(version: string) {
  return VERSION_META[version];
}

export function getLanguageLabel(language: string): string {
  return LANGUAGE_LABELS[normalizeLanguage(language)];
}

export function getCorePatternExample(language?: string) {
  return CORE_PATTERN_EXAMPLES[normalizeLanguage(language)];
}

export function getAllVersions(language?: string): AgentVersion[] {
  if (!language) return versionIndex.versions;
  const resolved = normalizeLanguage(language);
  return versionIndex.versions.filter((version) => version.language === resolved);
}

export function getVersion(language: string | undefined, versionId: string): AgentVersion | undefined {
  const resolved = normalizeLanguage(language);
  return versionIndex.versions.find(
    (version) => version.language === resolved && version.id === versionId
  );
}

export function getVersionDiff(language: string | undefined, versionId: string): VersionDiff | null {
  const resolved = normalizeLanguage(language);
  return (
    versionIndex.diffs.find(
      (diff) => diff.language === resolved && diff.to === versionId
    ) ?? null
  );
}

export function getDocs(language: string | undefined, versionId: string, locale: string): DocContent | undefined {
  const resolved = normalizeLanguage(language);
  return (
    docsIndex.find(
      (doc) =>
        doc.language === resolved &&
        doc.version === versionId &&
        doc.locale === locale
    ) ??
    docsIndex.find(
      (doc) =>
        doc.language === "shared" &&
        doc.version === versionId &&
        doc.locale === locale
    ) ??
    docsIndex.find(
      (doc) =>
        doc.language === resolved &&
        doc.version === versionId &&
        doc.locale === "en"
    ) ??
    docsIndex.find(
      (doc) =>
        doc.language === "shared" &&
        doc.version === versionId &&
        doc.locale === "en"
    )
  );
}

export function getAvailableLanguages(versionId: string): LearningLanguage[] {
  return LEARNING_LANGUAGES.filter((language) =>
    versionIndex.versions.some(
      (version) => version.language === language && version.id === versionId
    )
  );
}

export function hasLanguageVersion(language: string | undefined, versionId: string): boolean {
  return !!getVersion(language, versionId);
}

export function getPrevVersionId(versionId: string): VersionId | null {
  const index = LEARNING_PATH.indexOf(versionId as VersionId);
  return index > 0 ? LEARNING_PATH[index - 1] : null;
}

export function getNextVersionId(versionId: string): VersionId | null {
  const index = LEARNING_PATH.indexOf(versionId as VersionId);
  return index >= 0 && index < LEARNING_PATH.length - 1
    ? LEARNING_PATH[index + 1]
    : null;
}

export function getLanguageFromPathname(pathname: string | null): LearningLanguage {
  return getPathLanguageFromPathname(pathname) ?? DEFAULT_LANGUAGE;
}

export function resolveActiveLanguage(
  pathname: string | null,
  browserPathname: string | null,
  preferredLanguage?: string | null
): LearningLanguage {
  return (
    getPathLanguageFromPathname(pathname) ??
    getPathLanguageFromPathname(browserPathname) ??
    (preferredLanguage && LEARNING_LANGUAGES.includes(preferredLanguage as LearningLanguage)
      ? (preferredLanguage as LearningLanguage)
      : null) ??
    DEFAULT_LANGUAGE
  );
}

export function getPathnameForLanguage(
  pathname: string | null,
  language: string | undefined
): string {
  if (!pathname) return "/";

  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return pathname;
  if (!LEARNING_LANGUAGES.includes(segments[1] as LearningLanguage)) return pathname;

  const nextSegments = [...segments];
  nextSegments[1] = normalizeLanguage(language);
  return `/${nextSegments.join("/")}`;
}

export function getVersionRoute(locale: string, language: string | undefined, versionId: string): string {
  return `/${locale}/${normalizeLanguage(language)}/${versionId}`;
}

export function getDiffRoute(locale: string, language: string | undefined, versionId: string): string {
  return `${getVersionRoute(locale, language, versionId)}/diff`;
}

export function getLanguageOptions(versionId?: string) {
  const available = versionId ? getAvailableLanguages(versionId) : [...LEARNING_LANGUAGES];
  return available.map((language) => ({
    value: language,
    label: LANGUAGE_LABELS[language],
  }));
}

export function getVersionCountByLayer(language?: string, versionIds?: readonly string[]): number {
  const resolved = normalizeLanguage(language);
  return versionIndex.versions.filter(
    (version) =>
      version.language === resolved &&
      (!versionIds || versionIds.includes(version.id))
  ).length;
}
