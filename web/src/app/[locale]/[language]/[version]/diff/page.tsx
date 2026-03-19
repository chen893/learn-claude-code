import { getAllVersions } from "@/lib/learning";
import { DiffPageContent } from "@/components/pages/diff-page-content";

export function generateStaticParams() {
  return getAllVersions()
    .filter((item) => item.id !== "s01")
    .map((item) => ({
      language: item.language,
      version: item.id,
    }));
}

export default async function DiffPage({
  params,
}: {
  params: Promise<{ locale: string; language: string; version: string }>;
}) {
  const { language, version } = await params;
  return <DiffPageContent language={language} version={version} />;
}
