"use client";

import { useMemo } from "react";

interface SourceViewerProps {
  source: string;
  filename: string;
}

function getLanguageFromFilename(filename: string): "python" | "ts" {
  return filename.endsWith(".ts") ? "ts" : "python";
}

function highlightLine(line: string, language: "python" | "ts"): React.ReactNode[] {
  const trimmed = line.trimStart();
  if (
    (language === "python" && trimmed.startsWith("#")) ||
    (language === "ts" && trimmed.startsWith("//"))
  ) {
    return [
      <span key={0} className="text-zinc-400 italic">
        {line}
      </span>,
    ];
  }
  if (trimmed.startsWith("@")) {
    return [
      <span key={0} className="text-amber-400">
        {line}
      </span>,
    ];
  }
  if (
    (language === "python" && (trimmed.startsWith('"""') || trimmed.startsWith("'''"))) ||
    (language === "ts" && (trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("*/")))
  ) {
    return [
      <span key={0} className="text-emerald-500">
        {line}
      </span>,
    ];
  }

  const keywordSet = new Set(
    language === "ts"
      ? [
          "function", "class", "import", "from", "return", "if", "else",
          "while", "for", "in", "of", "true", "false", "try", "catch",
          "throw", "const", "let", "var", "async", "await", "export",
          "new", "null", "undefined", "type", "interface",
        ]
      : [
          "def", "class", "import", "from", "return", "if", "elif", "else",
          "while", "for", "in", "not", "and", "or", "is", "None", "True",
          "False", "try", "except", "raise", "with", "as", "yield", "break",
          "continue", "pass", "global", "lambda", "async", "await",
        ]
  );

  const keywordPattern =
    language === "ts"
      ? /\b(?:function|class|import|from|return|if|else|while|for|in|of|true|false|try|catch|throw|const|let|var|async|await|export|new|null|undefined|type|interface|this)\b|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/.*$|\b\d+(?:\.\d+)?\b/g
      : /\b(?:def|class|import|from|return|if|elif|else|while|for|in|not|and|or|is|None|True|False|try|except|raise|with|as|yield|break|continue|pass|global|lambda|async|await|self)\b|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|f"(?:[^"\\]|\\.)*"|f'(?:[^'\\]|\\.)*'|#.*$|\b\d+(?:\.\d+)?\b/g;

  const parts = line.split(new RegExp(`(${keywordPattern.source})`));

  return parts.map((part, idx) => {
    if (!part) return null;
    if (keywordSet.has(part)) {
      return <span key={idx} className="text-blue-400 font-medium">{part}</span>;
    }
    if (part === "self" || part === "this") {
      return <span key={idx} className="text-purple-400">{part}</span>;
    }
    if (part.startsWith("#") || part.startsWith("//")) {
      return <span key={idx} className="text-zinc-400 italic">{part}</span>;
    }
    if (
      (part.startsWith('"') && part.endsWith('"')) ||
      (part.startsWith("'") && part.endsWith("'")) ||
      (part.startsWith('f"') && part.endsWith('"')) ||
      (part.startsWith("f'") && part.endsWith("'")) ||
      (part.startsWith("`") && part.endsWith("`"))
    ) {
      return <span key={idx} className="text-emerald-500">{part}</span>;
    }
    if (/^\d+(?:\.\d+)?$/.test(part)) {
      return <span key={idx} className="text-orange-400">{part}</span>;
    }
    return <span key={idx}>{part}</span>;
  });
}

export function SourceViewer({ source, filename }: SourceViewerProps) {
  const lines = useMemo(() => source.split("\n"), [source]);
  const language = useMemo(() => getLanguageFromFilename(filename), [filename]);

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-700">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-700">
        <div className="flex gap-1.5">
          <span className="h-3 w-3 rounded-full bg-red-400" />
          <span className="h-3 w-3 rounded-full bg-yellow-400" />
          <span className="h-3 w-3 rounded-full bg-green-400" />
        </div>
        <span className="font-mono text-xs text-zinc-400">{filename}</span>
      </div>
      <div className="overflow-x-auto bg-zinc-950">
        <pre className="p-2 text-[10px] leading-4 sm:p-4 sm:text-xs sm:leading-5">
          <code>
            {lines.map((line, i) => (
              <div key={i} className="flex">
                <span className="mr-2 inline-block w-6 shrink-0 select-none text-right text-zinc-600 sm:mr-4 sm:w-8">
                  {i + 1}
                </span>
                <span className="text-zinc-200">
                  {highlightLine(line, language)}
                </span>
              </div>
            ))}
          </code>
        </pre>
      </div>
    </div>
  );
}
