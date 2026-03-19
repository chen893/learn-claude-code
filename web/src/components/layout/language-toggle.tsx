"use client";

import { useId } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

interface LanguageOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface LanguageToggleProps {
  value: string;
  options: LanguageOption[];
  onChange: (value: string) => void;
  className?: string;
}

export function LanguageToggle({
  value,
  options,
  onChange,
  className,
}: LanguageToggleProps) {
  const layoutId = useId();

  return (
    <div
      className={cn(
        "relative flex w-fit items-center rounded-xl bg-zinc-100/80 p-1 dark:bg-zinc-800/50",
        "border border-zinc-200/50 dark:border-zinc-700/50",
        className
      )}
    >
      {options.map((option) => {
        const isActive = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "relative flex items-center justify-center rounded-lg px-3 py-1.5 text-xs font-medium transition-colors sm:text-sm",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-1 focus-visible:ring-offset-zinc-50 dark:focus-visible:ring-offset-zinc-900",
              option.disabled
                ? "cursor-not-allowed text-zinc-400 opacity-50"
                : isActive
                  ? "text-zinc-900 dark:text-zinc-50"
                  : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200",
              "z-10"
            )}
            style={{ WebkitTapHighlightColor: "transparent" }}
          >
            {isActive && !option.disabled && (
              <motion.div
                layoutId={`active-bg-${layoutId}`}
                className="absolute inset-0 -z-10 rounded-lg bg-white shadow-sm dark:bg-zinc-900 border border-black/5 dark:border-white/5"
                initial={false}
                transition={{ type: "spring", bounce: 0.15, duration: 0.5 }}
              />
            )}
            <span className="relative z-10">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
