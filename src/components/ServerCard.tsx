"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { FavoriteButton } from "@/components/FavoriteButton";
import type { ServerListItem } from "@/lib/types";

interface ServerCardProps {
  server: ServerListItem;
  initialFavorited?: boolean;
  showFavoriteButton?: boolean;
  onFavoriteChange?: (serverId: string, favorited: boolean) => void;
}

/**
 * 服务器信息卡片 —— 展示名称、状态、玩家数、延迟、标签等核心信息。
 * 信息密度适中，字段顺序固定（见 .cursorrules）。
 */
export function ServerCard({
  server,
  initialFavorited,
  showFavoriteButton = true,
  onFavoriteChange,
}: ServerCardProps) {
  const {
    name,
    host,
    port,
    description,
    tags,
    status,
    isVerified,
    iconUrl,
    visibility,
    joinMode,
  } = server;
  const checkedAtMs = Date.parse(status.checkedAt);
  const isStale = !Number.isFinite(checkedAtMs) || Date.now() - checkedAtMs > 15 * 60 * 1000;
  const isOnline = status.online;
  const statusText = isStale ? "状态未知" : isOnline ? "在线" : "离线";
  const isAddressHidden = host === "hidden" && port === 0;
  const isUnlisted = visibility === "unlisted";
  const showApplyBadge =
    joinMode === "apply" || joinMode === "apply_and_invite";
  const showInviteBadge =
    joinMode === "invite" || joinMode === "apply_and_invite";

  const [pingMs, setPingMs] = useState<number | null>(null);

  useEffect(() => {
    if (isStale || !isOnline) return;
    const start = performance.now();
    fetch(`/api/servers/${server.id}/ping`, { cache: "no-store" })
      .then(() => {
        setPingMs(Math.round(performance.now() - start));
      })
      .catch(() => {
        /* ignore */
      });
  }, [server.id, isOnline, isStale]);

  return (
    <Link
      href={`/servers/${server.psid}`}
      className="m3-surface group block cursor-pointer p-4 transition-all hover:-translate-y-0.5 hover:border-slate-300 sm:p-5"
    >
      {/* 1. 名称 + 在线状态 */}
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="inline-flex h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
            <Image
              src={iconUrl || "/default-server-icon.png"}
              alt={`${name} 图标`}
              width={56}
              height={56}
              className="h-full w-full object-cover"
            />
          </span>

          <div className="min-w-0 flex-1">
            <h3 className="truncate text-base font-semibold text-slate-900 transition-colors group-hover:text-slate-700">
              {name}
            </h3>
            <div className="flex flex-wrap items-center gap-1">
              {isVerified && (
                <span
                  className="inline-flex items-center rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-medium text-teal-700 ring-1 ring-teal-100"
                  title="已认领 - 管理员已验证"
                >
                  ✓ 已认领
                </span>
              )}
              {isUnlisted && (
                <span
                  className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 ring-1 ring-amber-200"
                  title="半公开服务器 - 地址需申请后可见"
                >
                  需申请
                </span>
              )}
              {showApplyBadge && (
                <span
                  className="inline-flex items-center gap-0.5 rounded-full bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200"
                  title="申请制 - 需要提交申请加入"
                >
                  <svg
                    className="h-3 w-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                  </svg>
                  申请制
                </span>
              )}
              {showInviteBadge && (
                <span
                  className="inline-flex items-center gap-0.5 rounded-full bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200"
                  title="邀请制 - 需要邀请链接加入"
                >
                  <svg
                    className="h-3 w-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </svg>
                  邀请制
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {showFavoriteButton && (
            <FavoriteButton
              serverId={server.id}
              size="sm"
              initialFavorited={initialFavorited}
              onChange={(favorited) => {
                onFavoriteChange?.(server.id, favorited);
              }}
            />
          )}
          <span className="flex items-center gap-1.5 text-xs">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                isStale
                  ? "bg-slate-300"
                  : isOnline
                    ? "bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.35)]"
                    : "bg-slate-400"
              }`}
            />
            <span
              className={
                isStale ? "text-slate-400" : isOnline ? "text-emerald-600" : "text-slate-500"
              }
            >
              {statusText}
            </span>
          </span>
        </div>
      </div>

      {/* 2. 服务器地址 */}
      {isAddressHidden ? (
        <p className="mb-2 text-xs text-slate-400 italic">地址隐藏</p>
      ) : (
        <p className="mb-2 break-all font-mono text-xs text-slate-500">
          {host}
          {port !== 25565 ? `:${port}` : ""}
        </p>
      )}

      {/* 3. 简短描述（最多 2 行） */}
      {description && (
        <p className="mb-3 line-clamp-2 text-sm leading-relaxed text-slate-600">{description}</p>
      )}

      {/* 4. 在线人数 + 延迟 */}
      {!isStale && isOnline && (
        <div className="mb-3 flex items-center gap-3 text-xs">
          <span className="text-slate-600">
            <span className="font-medium text-slate-800">{status.playerCount}</span>
            <span> / {status.maxPlayers} 在线</span>
          </span>
          {pingMs !== null && (
            <span
              className={
                pingMs < 50 ? "text-emerald-600" : pingMs < 100 ? "text-amber-600" : "text-rose-600"
              }
            >
              {pingMs}ms
            </span>
          )}
        </div>
      )}

      {/* 5. 标签 Chips */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-xs text-slate-600"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </Link>
  );
}
