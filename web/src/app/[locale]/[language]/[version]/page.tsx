import Link from "next/link";
import { VersionDetailClient } from "@/components/pages/version-detail-client";
import { LayerBadge } from "@/components/ui/badge";
import { LAYERS } from "@/lib/constants";
import { getTranslations } from "@/lib/i18n-server";
import {
  getAllVersions,
  getDiffRoute,
  getLanguageLabel,
  getNextVersionId,
  getPrevVersionId,
  getVersion,
  getVersionDiff,
  getVersionMeta,
  getVersionRoute,
} from "@/lib/learning";

export function generateStaticParams() {
  return getAllVersions().map((item) => ({
    language: item.language,
    version: item.id,
  }));
}

export default async function VersionPage({
  params,
}: {
  params: Promise<{ locale: string; language: string; version: string }>;
}) {
  const { locale, language, version } = await params;
  const versionData = getVersion(language, version);
  const meta = getVersionMeta(version);
  const diff = getVersionDiff(language, version);

  if (!versionData || !meta) {
    return (
      <div className="py-20 text-center">
        <h1 className="text-2xl font-bold">Version not found</h1>
        <p className="mt-2 text-zinc-500">
          {language}/{version}
        </p>
      </div>
    );
  }

  const t = getTranslations(locale, "version");
  const tSession = getTranslations(locale, "sessions");
  const tLayer = getTranslations(locale, "layer_labels");
  const layer = LAYERS.find((item) => item.id === meta.layer);
  const prevVersion = getPrevVersionId(version);
  const nextVersion = getNextVersionId(version);

  return (
    <div className="mx-auto max-w-3xl space-y-10 py-4">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-lg bg-zinc-100 px-3 py-1 font-mono text-lg font-bold dark:bg-zinc-800">
            {version}
          </span>
          <h1 className="text-2xl font-bold sm:text-3xl">
            {tSession(version) || meta.title}
          </h1>
          {layer && <LayerBadge layer={meta.layer}>{tLayer(layer.id)}</LayerBadge>}
        </div>

        <p className="text-lg text-zinc-500 dark:text-zinc-400">{meta.subtitle}</p>

        <div className="flex flex-wrap items-center gap-4 text-sm text-zinc-500 dark:text-zinc-400">
          <span className="font-mono">{versionData.loc} LOC</span>
          <span>
            {versionData.tools.length} {t("tools")}
          </span>
          <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs dark:bg-zinc-800">
            {getLanguageLabel(language)}
          </span>
          {meta.coreAddition && (
            <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs dark:bg-zinc-800">
              {meta.coreAddition}
            </span>
          )}
        </div>

        {meta.keyInsight && (
          <blockquote className="border-l-4 border-zinc-300 pl-4 text-sm italic text-zinc-500 dark:border-zinc-600 dark:text-zinc-400">
            {meta.keyInsight}
          </blockquote>
        )}
      </header>

      <VersionDetailClient
        language={language}
        version={version}
        diff={diff}
        source={versionData.source}
        filename={versionData.filename}
      />

      <nav className="flex items-center justify-between border-t border-zinc-200 pt-6 dark:border-zinc-700">
        {prevVersion ? (
          <Link
            href={getVersionRoute(locale, language, prevVersion)}
            className="group flex items-center gap-2 text-sm text-zinc-500 transition-colors hover:text-zinc-900 dark:hover:text-white"
          >
            <span className="transition-transform group-hover:-translate-x-1">&larr;</span>
            <div>
              <div className="text-xs text-zinc-400">{t("prev")}</div>
              <div className="font-medium">
                {prevVersion} - {tSession(prevVersion) || getVersionMeta(prevVersion)?.title}
              </div>
            </div>
          </Link>
        ) : (
          <div />
        )}

        {diff && (
          <Link
            href={getDiffRoute(locale, language, version)}
            className="text-sm font-medium text-zinc-500 hover:text-zinc-900 dark:hover:text-white"
          >
            Diff
          </Link>
        )}

        {nextVersion ? (
          <Link
            href={getVersionRoute(locale, language, nextVersion)}
            className="group flex items-center gap-2 text-right text-sm text-zinc-500 transition-colors hover:text-zinc-900 dark:hover:text-white"
          >
            <div>
              <div className="text-xs text-zinc-400">{t("next")}</div>
              <div className="font-medium">
                {tSession(nextVersion) || getVersionMeta(nextVersion)?.title} - {nextVersion}
              </div>
            </div>
            <span className="transition-transform group-hover:translate-x-1">&rarr;</span>
          </Link>
        ) : (
          <div />
        )}
      </nav>
    </div>
  );
}
