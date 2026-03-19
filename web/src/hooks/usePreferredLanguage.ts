"use client";

import { useEffect, useState } from "react";
import { DEFAULT_LANGUAGE } from "@/lib/learning";

const STORAGE_KEY = "preferred-language";
const EVENT_NAME = "preferred-language-change";

export function readPreferredLanguage(): string {
  if (typeof window === "undefined") return DEFAULT_LANGUAGE;
  return localStorage.getItem(STORAGE_KEY) || DEFAULT_LANGUAGE;
}

export function writePreferredLanguage(language: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, language);
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: language }));
}

export function usePreferredLanguage() {
  const [language, setLanguage] = useState<string>(DEFAULT_LANGUAGE);

  useEffect(() => {
    setLanguage(readPreferredLanguage());

    const sync = () => setLanguage(readPreferredLanguage());
    const onCustomEvent = (event: Event) => {
      const nextLanguage = (event as CustomEvent<string>).detail;
      if (nextLanguage) setLanguage(nextLanguage);
    };

    window.addEventListener("storage", sync);
    window.addEventListener(EVENT_NAME, onCustomEvent);

    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(EVENT_NAME, onCustomEvent);
    };
  }, []);

  return language;
}
