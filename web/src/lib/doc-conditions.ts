export function resolveLanguageBlocks(md: string, language: string): string {
  return md.replace(
    /<Lang\s+when="([^"]+)">([\s\S]*?)<\/Lang>/gi,
    (_, when: string, content: string) => {
      const languages = when
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);

      return languages.includes(language.toLowerCase()) ? content.trim() : "";
    }
  );
}
