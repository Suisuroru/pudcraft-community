"use client";

import { useEffect, useState } from "react";

interface CopyIdBadgeProps {
  label: string;
  value: string;
}

/**
 * 数字 ID 展示 + 一键复制 badge。
 * 用于展示 PSID / UID 并支持复制。
 */
export function CopyIdBadge({ label, value }: CopyIdBadgeProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        return;
      } catch {
        // fallback
      }
    }

    if (typeof window !== "undefined") {
      window.prompt("浏览器不支持自动复制，请手动复制：", value);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-1.5 rounded-full bg-teal-50 px-2.5 py-1 text-xs font-medium text-teal-700 ring-1 ring-teal-100 transition-colors hover:bg-teal-100"
      title={`点击复制 ${label}`}
    >
      <span>
        {label}: {value}
      </span>
      <span className="text-teal-500">{copied ? "✓" : "⎘"}</span>
    </button>
  );
}
