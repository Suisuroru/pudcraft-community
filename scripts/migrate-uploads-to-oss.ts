/**
 * 本地文件全量迁移到对象存储脚本。
 *
 * 用法：
 *   pnpm migrate:uploads:dry
 *   STORAGE_DRIVER=s3 pnpm migrate:uploads
 *
 * 功能：
 *   1. 扫描 public/uploads/ 和 storage/ 下所有文件
 *   2. 规划需要上传的对象存储 key
 *   3. 严格检查数据库中所有历史存储值能否归一化为 key
 *   4. dry-run 仅输出统计；正式执行时上传并写回数据库
 *
 * 安全策略：
 *   - 发现任何无法转换的非空值，直接非零退出
 *   - dry-run 不上传、不写库
 *   - 正式执行前先完成完整规划，避免半程才发现脏数据
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { coerceStorageKey, getObjectStorageRuntimeConfig } from "../src/lib/storage";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PUBLIC_UPLOADS_DIR = path.join(PROJECT_ROOT, "public", "uploads");
const PRIVATE_STORAGE_DIR = path.join(PROJECT_ROOT, "storage");
const DRY_RUN_PREVIEW_LIMIT = 20;

const MIME_FROM_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mrpack: "application/x-modrinth-modpack+zip",
};

const cliArgsSchema = z.array(z.string()).superRefine((args, ctx) => {
  for (const arg of args) {
    if (arg !== "--dry-run") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `不支持的参数: ${arg}。仅支持 --dry-run`,
      });
    }
  }
});

type DbFieldLabel = "User.image" | "Server.iconUrl" | "Server.imageUrl" | "Modpack.fileKey";

interface MigrationReport {
  dryRun: boolean;
  scannedFiles: number;
  uploadCandidates: number;
  uploadedFiles: number;
  skippedFiles: number;
  failedFiles: string[];
  dbUpdatedUsers: number;
  dbUpdatedServerIcons: number;
  dbUpdatedServerImages: number;
  dbUpdatedModpacks: number;
  invalidLocalFiles: string[];
  invalidDbValues: InvalidDbValue[];
}

interface FilePlan {
  filePath: string;
  key: string;
}

interface InvalidDbValue {
  field: DbFieldLabel;
  recordId: string;
  value: string;
}

interface UserImageUpdatePlan {
  id: string;
  nextKey: string;
}

interface ServerImageUpdatePlan {
  id: string;
  nextKey: string;
}

interface ModpackUpdatePlan {
  id: string;
  nextKey: string;
}

interface DbMigrationPlan {
  userImageUpdates: UserImageUpdatePlan[];
  serverIconUpdates: ServerImageUpdatePlan[];
  serverImageUpdates: ServerImageUpdatePlan[];
  modpackFileUpdates: ModpackUpdatePlan[];
  invalidValues: InvalidDbValue[];
}

const report: MigrationReport = {
  dryRun: false,
  scannedFiles: 0,
  uploadCandidates: 0,
  uploadedFiles: 0,
  skippedFiles: 0,
  failedFiles: [],
  dbUpdatedUsers: 0,
  dbUpdatedServerIcons: 0,
  dbUpdatedServerImages: 0,
  dbUpdatedModpacks: 0,
  invalidLocalFiles: [],
  invalidDbValues: [],
};

function createObjectStorageClient(): S3Client {
  const config = getObjectStorageRuntimeConfig();

  return new S3Client({
    region: config.region,
    endpoint: config.endpoint ?? undefined,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.accessKeySecret,
    },
    forcePathStyle: config.forcePathStyle,
  });
}

function guessContentType(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return MIME_FROM_EXTENSION[ext] ?? "application/octet-stream";
}

async function objectStorageExists(client: S3Client, key: string): Promise<boolean> {
  const config = getObjectStorageRuntimeConfig();
  try {
    await client.send(new HeadObjectCommand({
      Bucket: config.bucket,
      Key: key,
    }));
    return true;
  } catch {
    return false;
  }
}

async function scanDir(dir: string): Promise<string[]> {
  const results: string[] = [];

  if (!fs.existsSync(dir)) {
    return results;
  }

  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".gitkeep" || entry.name.startsWith(".")) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    const stat = await fsp.lstat(fullPath);

    if (stat.isSymbolicLink()) {
      console.log(`  [跳过] 符号链接: ${fullPath}`);
      continue;
    }

    if (stat.isDirectory()) {
      const nestedFiles = await scanDir(fullPath);
      results.push(...nestedFiles);
      continue;
    }

    if (stat.isFile()) {
      results.push(fullPath);
    }
  }

  return results;
}

function localPathToStorageKey(filePath: string): string | null {
  return coerceStorageKey(filePath);
}

function previewInvalidLocalFiles(files: readonly string[]): void {
  if (files.length === 0) {
    return;
  }

  console.log("\n  ❌ 无法识别的本地文件路径:");
  for (const filePath of files.slice(0, DRY_RUN_PREVIEW_LIMIT)) {
    console.log(`     - ${filePath}`);
  }

  if (files.length > DRY_RUN_PREVIEW_LIMIT) {
    console.log(`     ... 其余 ${files.length - DRY_RUN_PREVIEW_LIMIT} 项未展开`);
  }
}

function previewInvalidDbValues(items: readonly InvalidDbValue[]): void {
  if (items.length === 0) {
    return;
  }

  console.log("\n  ❌ 无法归一化的数据库值:");
  for (const item of items.slice(0, DRY_RUN_PREVIEW_LIMIT)) {
    console.log(`     - ${item.field} (${item.recordId}): ${item.value}`);
  }

  if (items.length > DRY_RUN_PREVIEW_LIMIT) {
    console.log(`     ... 其余 ${items.length - DRY_RUN_PREVIEW_LIMIT} 项未展开`);
  }
}

function resolveDbUpdate(
  field: DbFieldLabel,
  recordId: string,
  value: string | null,
): { nextKey: string } | { invalid: InvalidDbValue } | null {
  if (!value) {
    return null;
  }

  const nextKey = coerceStorageKey(value);
  if (!nextKey) {
    return {
      invalid: {
        field,
        recordId,
        value,
      },
    };
  }

  if (nextKey === value) {
    return null;
  }

  return { nextKey };
}

async function buildDbMigrationPlan(prisma: PrismaClient): Promise<DbMigrationPlan> {
  const [users, servers, modpacks] = await Promise.all([
    prisma.user.findMany({
      where: { image: { not: null } },
      select: { id: true, image: true },
    }),
    prisma.server.findMany({
      select: { id: true, iconUrl: true, imageUrl: true },
    }),
    prisma.modpack.findMany({
      select: { id: true, fileKey: true },
    }),
  ]);

  const plan: DbMigrationPlan = {
    userImageUpdates: [],
    serverIconUpdates: [],
    serverImageUpdates: [],
    modpackFileUpdates: [],
    invalidValues: [],
  };

  for (const user of users) {
    const resolved = resolveDbUpdate("User.image", user.id, user.image);
    if (!resolved) {
      continue;
    }
    if ("invalid" in resolved) {
      plan.invalidValues.push(resolved.invalid);
      continue;
    }
    plan.userImageUpdates.push({
      id: user.id,
      nextKey: resolved.nextKey,
    });
  }

  for (const server of servers) {
    const resolvedIcon = resolveDbUpdate("Server.iconUrl", server.id, server.iconUrl);
    if (resolvedIcon) {
      if ("invalid" in resolvedIcon) {
        plan.invalidValues.push(resolvedIcon.invalid);
      } else {
        plan.serverIconUpdates.push({
          id: server.id,
          nextKey: resolvedIcon.nextKey,
        });
      }
    }

    const resolvedImage = resolveDbUpdate("Server.imageUrl", server.id, server.imageUrl);
    if (resolvedImage) {
      if ("invalid" in resolvedImage) {
        plan.invalidValues.push(resolvedImage.invalid);
      } else {
        plan.serverImageUpdates.push({
          id: server.id,
          nextKey: resolvedImage.nextKey,
        });
      }
    }
  }

  for (const modpack of modpacks) {
    const resolved = resolveDbUpdate("Modpack.fileKey", modpack.id, modpack.fileKey);
    if (!resolved) {
      continue;
    }
    if ("invalid" in resolved) {
      plan.invalidValues.push(resolved.invalid);
      continue;
    }
    plan.modpackFileUpdates.push({
      id: modpack.id,
      nextKey: resolved.nextKey,
    });
  }

  return plan;
}

function parseRuntimeMode(args: readonly string[]): { dryRun: boolean } {
  const parsedArgs = cliArgsSchema.parse([...args]);
  return {
    dryRun: parsedArgs.includes("--dry-run"),
  };
}

async function applyDbUpdates(prisma: PrismaClient, plan: DbMigrationPlan): Promise<void> {
  for (const item of plan.userImageUpdates) {
    await prisma.user.update({
      where: { id: item.id },
      data: { image: item.nextKey },
    });
    report.dbUpdatedUsers++;
    console.log(`  [更新] User ${item.id}: image → ${item.nextKey}`);
  }

  for (const item of plan.serverIconUpdates) {
    await prisma.server.update({
      where: { id: item.id },
      data: { iconUrl: item.nextKey },
    });
    report.dbUpdatedServerIcons++;
    console.log(`  [更新] Server ${item.id}: iconUrl → ${item.nextKey}`);
  }

  for (const item of plan.serverImageUpdates) {
    await prisma.server.update({
      where: { id: item.id },
      data: { imageUrl: item.nextKey },
    });
    report.dbUpdatedServerImages++;
    console.log(`  [更新] Server ${item.id}: imageUrl → ${item.nextKey}`);
  }

  for (const item of plan.modpackFileUpdates) {
    await prisma.modpack.update({
      where: { id: item.id },
      data: { fileKey: item.nextKey },
    });
    report.dbUpdatedModpacks++;
    console.log(`  [更新] Modpack ${item.id}: fileKey → ${item.nextKey}`);
  }
}

function printPlanSummary(dbPlan: DbMigrationPlan): void {
  const dbUpdateTotal =
    dbPlan.userImageUpdates.length +
    dbPlan.serverIconUpdates.length +
    dbPlan.serverImageUpdates.length +
    dbPlan.modpackFileUpdates.length;

  console.log("\n═══════════════════════════════════════════════");
  console.log(report.dryRun ? "  迁移预检查（dry-run）" : "  迁移计划");
  console.log("═══════════════════════════════════════════════");
  console.log(`  扫描文件数:           ${report.scannedFiles}`);
  console.log(`  待上传文件数:         ${report.uploadCandidates}`);
  console.log(`  待更新 User.image:    ${dbPlan.userImageUpdates.length}`);
  console.log(`  待更新 Server.iconUrl:${dbPlan.serverIconUpdates.length}`);
  console.log(`  待更新 Server.imageUrl:${dbPlan.serverImageUpdates.length}`);
  console.log(`  待更新 Modpack.fileKey:${dbPlan.modpackFileUpdates.length}`);
  console.log(`  DB 待更新总数:        ${dbUpdateTotal}`);
  console.log(`  无法识别本地文件:     ${report.invalidLocalFiles.length}`);
  console.log(`  无法转换 DB 值:       ${dbPlan.invalidValues.length}`);
  console.log("═══════════════════════════════════════════════");

  previewInvalidLocalFiles(report.invalidLocalFiles);
  previewInvalidDbValues(dbPlan.invalidValues);
}

function printExecutionSummary(): void {
  console.log("\n═══════════════════════════════════════════════");
  console.log("  迁移执行结果");
  console.log("═══════════════════════════════════════════════");
  console.log(`  成功上传:             ${report.uploadedFiles}`);
  console.log(`  已跳过:               ${report.skippedFiles}`);
  console.log(`  上传失败:             ${report.failedFiles.length}`);
  console.log(`  User.image 更新:      ${report.dbUpdatedUsers}`);
  console.log(`  Server.iconUrl 更新:  ${report.dbUpdatedServerIcons}`);
  console.log(`  Server.imageUrl 更新: ${report.dbUpdatedServerImages}`);
  console.log(`  Modpack.fileKey 更新: ${report.dbUpdatedModpacks}`);

  if (report.failedFiles.length > 0) {
    console.log("\n  ❌ 上传失败文件:");
    for (const filePath of report.failedFiles.slice(0, DRY_RUN_PREVIEW_LIMIT)) {
      console.log(`     - ${filePath}`);
    }

    if (report.failedFiles.length > DRY_RUN_PREVIEW_LIMIT) {
      console.log(`     ... 其余 ${report.failedFiles.length - DRY_RUN_PREVIEW_LIMIT} 项未展开`);
    }
  }

  console.log("═══════════════════════════════════════════════");
}

async function uploadFiles(
  client: S3Client,
  filePlans: readonly FilePlan[],
): Promise<void> {
  const config = getObjectStorageRuntimeConfig();
  console.log("\n☁️  Step 3: 上传到对象存储...\n");

  for (const plan of filePlans) {
    try {
      const exists = await objectStorageExists(client, plan.key);
      if (exists) {
        console.log(`  [已存在] ${plan.key}`);
        report.skippedFiles++;
        continue;
      }

      const buffer = await fsp.readFile(plan.filePath);
      await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: plan.key,
        Body: buffer,
        ContentType: guessContentType(plan.filePath),
      }));

      console.log(`  [上传] ${plan.key} (${(buffer.byteLength / 1024).toFixed(1)} KB)`);
      report.uploadedFiles++;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`  [失败] ${plan.key}: ${reason}`);
      report.failedFiles.push(plan.filePath);
    }
  }
}

async function main(): Promise<number> {
  const { dryRun } = parseRuntimeMode(process.argv.slice(2));
  report.dryRun = dryRun;

  console.log("═══════════════════════════════════════════════");
  console.log(dryRun ? "  Pudcraft 对象存储迁移预检查" : "  Pudcraft 本地文件 → 对象存储迁移");
  console.log("═══════════════════════════════════════════════\n");

  const prisma = new PrismaClient();

  try {
    console.log("📁 Step 1: 扫描本地文件...\n");

    const publicFiles = await scanDir(PUBLIC_UPLOADS_DIR);
    const privateFiles = await scanDir(PRIVATE_STORAGE_DIR);
    const allFiles = [...publicFiles, ...privateFiles];

    report.scannedFiles = allFiles.length;
    console.log(`  发现 ${publicFiles.length} 个公开文件 (public/uploads/)`);
    console.log(`  发现 ${privateFiles.length} 个私有文件 (storage/)`);
    console.log(`  共计 ${allFiles.length} 个文件`);

    const filePlans: FilePlan[] = [];
    for (const filePath of allFiles) {
      const key = localPathToStorageKey(filePath);
      if (!key) {
        report.invalidLocalFiles.push(filePath);
        continue;
      }

      filePlans.push({ filePath, key });
    }
    report.uploadCandidates = filePlans.length;

    console.log("\n🗄️  Step 2: 分析数据库字段...\n");
    const dbPlan = await buildDbMigrationPlan(prisma);
    report.invalidDbValues = [...dbPlan.invalidValues];

    printPlanSummary(dbPlan);

    const hasBlockingIssues =
      report.invalidLocalFiles.length > 0 || dbPlan.invalidValues.length > 0;

    if (dryRun) {
      if (hasBlockingIssues) {
        console.error("\n⚠️  dry-run 发现无法转换的值，已阻止正式迁移。");
        return 1;
      }

      console.log("\n✅ dry-run 完成：当前没有阻塞性脏数据，可执行正式迁移。");
      return 0;
    }

    const driver = (process.env.STORAGE_DRIVER ?? "").trim().toLowerCase();
    if (driver !== "s3" && driver !== "oss") {
      console.error("\n⚠️  正式迁移必须设置 STORAGE_DRIVER=s3");
      console.error("   用法: STORAGE_DRIVER=s3 pnpm migrate:uploads");
      return 1;
    }

    if (hasBlockingIssues) {
      console.error("\n⚠️  检测到无法转换的值，已中止正式迁移。请先清理脏数据后重试。");
      return 1;
    }

    const objectStorageClient = createObjectStorageClient();
    await uploadFiles(objectStorageClient, filePlans);

    console.log("\n🗄️  Step 4: 回写数据库...\n");
    await applyDbUpdates(prisma, dbPlan);
    printExecutionSummary();

    if (report.failedFiles.length > 0) {
      console.error("\n⚠️  部分文件上传失败，请修复后重试（脚本可安全重跑）。");
      return 1;
    }

    console.log("\n✅ 迁移完成！");
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((error: unknown) => {
    console.error("\n💥 迁移脚本执行失败:", error);
    process.exit(1);
  });
