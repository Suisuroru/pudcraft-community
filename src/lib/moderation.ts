/**
 * 内容审查模块
 * 支持 OpenAI 兼容协议（DeepSeek / OpenAI / OpenRouter 等）和 Anthropic 原生协议
 *
 * 环境变量：
 *   MODERATION_API_KEY   — API 密钥（或旧名 DEEPSEEK_API_KEY）
 *   MODERATION_BASE_URL  — API 根地址，默认 https://api.deepseek.com
 *   MODERATION_MODE      — openai | anthropic，默认 openai
 *   MODERATION_MODEL     — 模型名，默认 deepseek-chat
 *   MODERATION_ENABLED   — true | false，默认 true
 */
import { prisma } from "@/lib/db";
import { moderationEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

export interface ModerationResult {
  passed: boolean;
  reason?: string;
  category?: string;
}

export interface ModerationOptions {
  contentId?: string;
  userId?: string;
  userIp?: string;
}

type ModerationContext = "server" | "modpack" | "username" | "comment";

const CONTEXT_LABELS: Record<ModerationContext, string> = {
  server: "服务器",
  modpack: "整合包",
  username: "用户名",
  comment: "评论",
};

const SYSTEM_PROMPT = `你是一个内容审查助手，负责审查中国游戏社区（Minecraft）平台上的用户提交内容。

审查标准（发现任何一项则不通过）：
- 政治敏感内容（涉及敏感政治话题、领导人、政治事件）
- 违法内容（赌博、诈骗、非法交易、色情）
- 仇恨言论（民族歧视、地域攻击、人身攻击）
- 广告垃圾（无关推广、引流、联系方式堆砌）
- 暴力恐怖内容

不需要审查：
- Minecraft 相关正常词汇（PVP、服务器、模组等）
- 普通游戏用语和玩家昵称
- 英文游戏名词

只返回 JSON，格式：
{
  "passed": true 或 false,
  "category": "违规类别（passed为true时省略）",
  "reason": "一句话说明原因（passed为true时省略）"
}`;

type RawModerationResult = { passed?: boolean; category?: string; reason?: string };

/** 调用 OpenAI 兼容协议（/chat/completions） */
async function callOpenAI(
  userContent: string,
  maxTokens: number,
  timeoutMs: number,
): Promise<RawModerationResult> {
  const url = `${moderationEnv.baseUrl}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${moderationEnv.apiKey}`,
    },
    body: JSON.stringify({
      model: moderationEnv.model,
      max_tokens: maxTokens,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    logger.error("[Moderation] OpenAI API error:", response.status);
    return { passed: true };
  }

  const data: { choices: Array<{ message: { content: string } }> } = await response.json();
  return JSON.parse(data.choices[0].message.content) as RawModerationResult;
}

/** 调用 Anthropic 原生协议（/v1/messages） */
async function callAnthropic(
  userContent: string,
  maxTokens: number,
  timeoutMs: number,
): Promise<RawModerationResult> {
  const baseUrl = moderationEnv.baseUrl.replace(/\/$/, "");
  const url = `${baseUrl}/v1/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": moderationEnv.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: moderationEnv.model,
      max_tokens: maxTokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    logger.error("[Moderation] Anthropic API error:", response.status);
    return { passed: true };
  }

  const data: { content: Array<{ type: string; text: string }> } = await response.json();
  const text = data.content.find((b) => b.type === "text")?.text ?? '{"passed":true}';
  // 从可能混入说明文字的响应里提取 JSON 对象
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse(match?.[0] ?? '{"passed":true}') as RawModerationResult;
}

/** 统一调用入口，根据 MODERATION_MODE 选择协议 */
async function callModerationAPI(
  userContent: string,
  maxTokens: number,
  timeoutMs: number,
): Promise<RawModerationResult> {
  try {
    if (moderationEnv.mode === "anthropic") {
      return await callAnthropic(userContent, maxTokens, timeoutMs);
    }
    return await callOpenAI(userContent, maxTokens, timeoutMs);
  } catch (error) {
    logger.error("[Moderation] Error:", error);
    return { passed: true };
  }
}

/** 写入审查日志（失败不阻塞主流程） */
function writeModerationLog(
  contentType: ModerationContext,
  contentSnippet: string,
  passed: boolean,
  aiCategory: string | undefined,
  aiReason: string | undefined,
  options?: ModerationOptions,
): void {
  prisma.moderationLog
    .create({
      data: {
        contentType,
        contentId: options?.contentId ?? null,
        contentSnippet: contentSnippet.slice(0, 500),
        passed,
        aiCategory: aiCategory ?? null,
        aiReason: aiReason ?? null,
        userId: options?.userId ?? null,
        userIp: options?.userIp ?? null,
      },
    })
    .catch((err: unknown) => {
      logger.error("[Moderation] Failed to write log:", err);
    });
}

/**
 * 审查单段文本内容
 */
export async function moderateContent(
  text: string,
  context: ModerationContext = "comment",
  options?: ModerationOptions,
): Promise<ModerationResult> {
  if (!moderationEnv.enabled) return { passed: true };

  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 2) return { passed: true };

  const maxLength = context === "username" ? 50 : 500;
  const content = trimmed.slice(0, maxLength);
  const userContent = `审查以下${CONTEXT_LABELS[context]}内容：\n\n${content}`;

  const result = await callModerationAPI(userContent, 100, 8000);
  const passed = Boolean(result.passed);

  writeModerationLog(context, content, passed, result.category, result.reason, options);

  return {
    passed,
    category: result.category,
    reason: result.reason,
  };
}

/**
 * 批量审查多个字段（合并为一次请求，节省费用）
 */
export async function moderateFields(
  fields: Record<string, string>,
  context: ModerationContext = "comment",
  options?: ModerationOptions,
): Promise<{ passed: boolean; failedField?: string; reason?: string }> {
  if (!moderationEnv.enabled) return { passed: true };

  const combined = Object.entries(fields)
    .filter(([, v]) => v?.trim())
    .map(([k, v]) => `【${k}】${v.slice(0, 200)}`)
    .join("\n");

  if (!combined) return { passed: true };

  const userContent = `审查以下${CONTEXT_LABELS[context]}的多个字段，如有问题请指出是哪个字段：\n\n${combined}`;
  const result = await callModerationAPI(userContent, 150, 10000);
  const passed = Boolean(result.passed);

  writeModerationLog(context, combined, passed, result.category, result.reason, options);

  return {
    passed,
    failedField: result.category,
    reason: result.reason,
  };
}
