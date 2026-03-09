# Private Servers + Whitelist Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add private/unlisted server support with application/invitation membership and Bukkit/Fabric whitelist auto-sync via WebSocket.

**Architecture:** Extend existing Prisma schema with visibility/joinMode fields and 4 new models (ServerApplication, ServerInvite, ServerMember, WhitelistSync). Add new API routes for membership management and plugin sync. Deploy a new standalone WebSocket server process that communicates with the Next.js app via Redis pub/sub.

**Tech Stack:** Prisma (migration), Zod (validation), Next.js API Routes, `ws` library (WebSocket server), Redis pub/sub, esbuild (WS server bundle), Docker Compose (new container)

**Note:** This project has no test framework. Verification steps use `pnpm lint`, `pnpm tsc --noEmit`, and manual curl/browser testing.

---

## Task 1: Prisma Schema Migration

**Files:**
- Modify: `prisma/schema.prisma`

**Step 1: Add new fields to Server model**

Add after `rejectReason` field (line ~69):

```prisma
  visibility      String  @default("public") @map("visibility")       // public | private | unlisted
  joinMode        String  @default("open") @map("join_mode")          // open | apply | invite | apply_and_invite
  applicationForm Json?   @map("application_form")
  apiKeyHash      String? @map("api_key_hash")
```

Add new relations to Server model (after `modpacks` relation):

```prisma
  applications ServerApplication[]
  invites      ServerInvite[]
  members      ServerMember[]
  syncs        WhitelistSync[]
```

Add new relations to User model (after `changelogs` relation):

```prisma
  applications    ServerApplication[] @relation("ApplicationUser")
  reviewedApps    ServerApplication[] @relation("ApplicationReviewer")
  serverInvites   ServerInvite[]
  serverMembers   ServerMember[]
```

**Step 2: Add ServerApplication model**

```prisma
model ServerApplication {
  id         String   @id @default(cuid())
  serverId   String   @map("server_id")
  userId     String   @map("user_id")
  status     String   @default("pending") @map("status") // pending | approved | rejected | cancelled
  formData   Json?    @map("form_data")
  reviewNote String?  @map("review_note")
  reviewedBy String?  @map("reviewed_by")
  createdAt  DateTime @default(now()) @map("created_at")
  updatedAt  DateTime @updatedAt @map("updated_at")

  server   Server @relation(fields: [serverId], references: [id], onDelete: Cascade)
  user     User   @relation("ApplicationUser", fields: [userId], references: [id], onDelete: Cascade)
  reviewer User?  @relation("ApplicationReviewer", fields: [reviewedBy], references: [id], onDelete: SetNull)

  @@unique([serverId, userId], name: "unique_server_application")
  @@index([serverId, status])
  @@index([userId])
  @@map("server_applications")
}
```

**Step 3: Add ServerInvite model**

```prisma
model ServerInvite {
  id        String    @id @default(cuid())
  serverId  String    @map("server_id")
  code      String    @unique
  createdBy String    @map("created_by")
  maxUses   Int?      @map("max_uses")
  usedCount Int       @default(0) @map("used_count")
  expiresAt DateTime? @map("expires_at")
  createdAt DateTime  @default(now()) @map("created_at")

  server  Server @relation(fields: [serverId], references: [id], onDelete: Cascade)
  creator User   @relation(fields: [createdBy], references: [id], onDelete: Cascade)

  @@index([serverId])
  @@map("server_invites")
}
```

**Step 4: Add ServerMember model**

```prisma
model ServerMember {
  id         String   @id @default(cuid())
  serverId   String   @map("server_id")
  userId     String   @map("user_id")
  joinedVia  String   @map("joined_via") // apply | invite
  mcUsername String?  @map("mc_username")
  createdAt  DateTime @default(now()) @map("created_at")

  server Server          @relation(fields: [serverId], references: [id], onDelete: Cascade)
  user   User            @relation(fields: [userId], references: [id], onDelete: Cascade)
  syncs  WhitelistSync[]

  @@unique([serverId, userId], name: "unique_server_member")
  @@index([serverId])
  @@index([userId])
  @@map("server_members")
}
```

**Step 5: Add WhitelistSync model**

```prisma
model WhitelistSync {
  id            String    @id @default(cuid())
  serverId      String    @map("server_id")
  memberId      String    @map("member_id")
  action        String    // add | remove
  status        String    @default("pending") // pending | pushed | acked | failed
  retryCount    Int       @default(0) @map("retry_count")
  lastAttemptAt DateTime? @map("last_attempt_at")
  ackedAt       DateTime? @map("acked_at")
  createdAt     DateTime  @default(now()) @map("created_at")

  server Server       @relation(fields: [serverId], references: [id], onDelete: Cascade)
  member ServerMember @relation(fields: [memberId], references: [id], onDelete: Cascade)

  @@index([serverId, status])
  @@index([memberId])
  @@map("whitelist_syncs")
}
```

**Step 6: Run migration**

```bash
pnpm db:migrate --name add_private_servers_and_whitelist_sync
```

**Step 7: Verify**

```bash
pnpm tsc --noEmit
```

**Step 8: Commit**

```bash
git add prisma/
git commit -m "feat: add private server and whitelist sync schema"
```

---

## Task 2: Zod Validation Schemas

**Files:**
- Modify: `src/lib/validation.ts`

**Step 1: Add private server schemas**

Add after the `updateServerSchema` (line ~107):

```typescript
/** 服务器可见性 */
export const serverVisibilitySchema = z.enum(["public", "private", "unlisted"]);

/** 服务器加入模式 */
export const serverJoinModeSchema = z.enum(["open", "apply", "invite", "apply_and_invite"]);

/** 申请表单字段配置（单个字段） */
const applicationFormFieldSchema = z.object({
  key: z.string().min(1).max(50),
  label: z.string().min(1).max(100),
  type: z.enum(["text", "textarea", "select", "multiselect"]),
  required: z.boolean().default(true),
  options: z.array(z.string().max(100)).max(20).optional(),
  placeholder: z.string().max(200).optional(),
});

/** 服务器私域设置 */
export const updateServerSettingsSchema = z.object({
  visibility: serverVisibilitySchema.optional(),
  joinMode: serverJoinModeSchema.optional(),
  applicationForm: z.array(applicationFormFieldSchema).max(10).nullable().optional(),
});

/** 提交入服申请 */
export const createApplicationSchema = z.object({
  formData: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  mcUsername: z
    .string()
    .min(3, "MC 用户名至少 3 个字符")
    .max(16, "MC 用户名最多 16 个字符")
    .regex(/^[a-zA-Z0-9_]+$/, "MC 用户名只能包含字母、数字和下划线"),
});

/** 审批申请 */
export const reviewApplicationSchema = z.object({
  action: z.enum(["approve", "reject"]),
  reviewNote: z.string().max(500).optional(),
});

/** 生成邀请码 */
export const createInviteSchema = z.object({
  maxUses: z.number().int().min(1).max(1000).nullable().optional(),
  expiresInHours: z.number().int().min(1).max(720).nullable().optional(),
});

/** 使用邀请码加入 */
export const joinByInviteSchema = z.object({
  mcUsername: z
    .string()
    .min(3, "MC 用户名至少 3 个字符")
    .max(16, "MC 用户名最多 16 个字符")
    .regex(/^[a-zA-Z0-9_]+$/, "MC 用户名只能包含字母、数字和下划线"),
});

/** 插件握手 */
export const syncHandshakeSchema = z.object({
  apiKey: z.string().min(1),
  pluginVersion: z.string().max(50).optional(),
});

/** 申请列表查询参数 */
export const queryApplicationsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  status: z.enum(["all", "pending", "approved", "rejected"]).default("pending"),
});

/** 成员列表查询参数 */
export const queryMembersSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
```

Add corresponding type exports at the end of the file:

```typescript
export type ServerVisibility = z.infer<typeof serverVisibilitySchema>;
export type ServerJoinMode = z.infer<typeof serverJoinModeSchema>;
export type UpdateServerSettingsInput = z.infer<typeof updateServerSettingsSchema>;
export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;
export type ReviewApplicationInput = z.infer<typeof reviewApplicationSchema>;
export type CreateInviteInput = z.infer<typeof createInviteSchema>;
export type JoinByInviteInput = z.infer<typeof joinByInviteSchema>;
export type SyncHandshakeInput = z.infer<typeof syncHandshakeSchema>;
export type QueryApplicationsInput = z.infer<typeof queryApplicationsSchema>;
export type QueryMembersInput = z.infer<typeof queryMembersSchema>;
```

**Step 2: Verify**

```bash
pnpm tsc --noEmit && pnpm lint
```

**Step 3: Commit**

```bash
git add src/lib/validation.ts
git commit -m "feat: add Zod schemas for private servers and whitelist sync"
```

---

## Task 3: Type Definitions

**Files:**
- Modify: `src/lib/types.ts`

**Step 1: Add private server types**

Add after the `ChangelogType` types section:

```typescript
// --- Private Server Types ---

export type ServerVisibility = "public" | "private" | "unlisted";
export type ServerJoinMode = "open" | "apply" | "invite" | "apply_and_invite";
export type ApplicationStatus = "pending" | "approved" | "rejected" | "cancelled";
export type SyncStatus = "pending" | "pushed" | "acked" | "failed";

/** Application form field configuration */
export interface ApplicationFormField {
  key: string;
  label: string;
  type: "text" | "textarea" | "select" | "multiselect";
  required: boolean;
  options?: string[];
  placeholder?: string;
}

/** Server application list item */
export interface ServerApplicationItem {
  id: string;
  userId: string;
  userName: string | null;
  userImage: string | null;
  mcUsername: string;
  status: ApplicationStatus;
  formData: Record<string, string | string[]> | null;
  reviewNote: string | null;
  reviewerName: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Server invite list item */
export interface ServerInviteItem {
  id: string;
  code: string;
  creatorName: string | null;
  maxUses: number | null;
  usedCount: number;
  expiresAt: string | null;
  createdAt: string;
}

/** Server member list item */
export interface ServerMemberItem {
  id: string;
  userId: string;
  userName: string | null;
  userImage: string | null;
  mcUsername: string | null;
  joinedVia: "apply" | "invite";
  createdAt: string;
  syncStatus: SyncStatus | null;
}

/** Whitelist sync record */
export interface WhitelistSyncItem {
  id: string;
  memberId: string;
  mcUsername: string | null;
  action: "add" | "remove";
  status: SyncStatus;
  retryCount: number;
  lastAttemptAt: string | null;
  ackedAt: string | null;
  createdAt: string;
}

/** Sync status overview (for console) */
export interface SyncStatusOverview {
  connected: boolean;
  pendingCount: number;
  failedCount: number;
  lastAckedAt: string | null;
  recentSyncs: WhitelistSyncItem[];
}

/** Membership status (for player) */
export interface MembershipStatus {
  isMember: boolean;
  application: {
    id: string;
    status: ApplicationStatus;
    createdAt: string;
  } | null;
}
```

**Step 2: Update ServerListItem and ServerDetail**

Add fields to `ServerListItem` interface (after `rejectReason`):

```typescript
  /** Server visibility */
  visibility?: ServerVisibility;
  /** Join mode for private servers */
  joinMode?: ServerJoinMode;
  /** Whether current user is a member (for address visibility) */
  isMember?: boolean;
```

**Step 3: Verify**

```bash
pnpm tsc --noEmit
```

**Step 4: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: add type definitions for private servers"
```

---

## Task 4: API Key Utility

**Files:**
- Create: `src/lib/api-key.ts`

**Step 1: Create API key generation and hashing utility**

```typescript
import { randomBytes, createHash } from "crypto";

const API_KEY_PREFIX = "pdc_";
const API_KEY_BYTES = 32;

/** Generate a new API key. Returns { raw, hash } — raw is shown once, hash is stored. */
export function generateApiKey(): { raw: string; hash: string } {
  const raw = API_KEY_PREFIX + randomBytes(API_KEY_BYTES).toString("hex");
  const hash = hashApiKey(raw);
  return { raw, hash };
}

/** Hash an API key for storage/comparison. */
export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
```

**Step 2: Verify**

```bash
pnpm tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/lib/api-key.ts
git commit -m "feat: add API key generation utility"
```

---

## Task 5: Server Address Access Guard

**Files:**
- Create: `src/lib/server-membership.ts`

**Step 1: Create membership check utility**

This utility checks whether a user can see a server's address and provides reusable membership queries.

```typescript
import { prisma } from "@/lib/db";

/** Check if a user is a member of a private/unlisted server. */
export async function isServerMember(serverId: string, userId: string): Promise<boolean> {
  const member = await prisma.serverMember.findUnique({
    where: { unique_server_member: { serverId, userId } },
    select: { id: true },
  });
  return member !== null;
}

/** Check if user can see server address based on visibility and membership. */
export async function canSeeServerAddress(
  server: { visibility: string; ownerId: string | null },
  userId: string | undefined,
  userRole: string | undefined,
  serverId: string,
): Promise<boolean> {
  if (server.visibility === "public") return true;
  if (!userId) return false;
  if (userRole === "admin") return true;
  if (server.ownerId === userId) return true;
  return isServerMember(serverId, userId);
}

/** Require server ownership for console operations. */
export async function requireServerOwner(
  serverId: string,
  userId: string,
): Promise<{ id: string; ownerId: string | null } | null> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { id: true, ownerId: true },
  });
  if (!server || server.ownerId !== userId) return null;
  return server;
}
```

**Step 2: Verify**

```bash
pnpm tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/lib/server-membership.ts
git commit -m "feat: add server membership check utilities"
```

---

## Task 6: Modify Existing Server List & Detail APIs

**Files:**
- Modify: `src/app/api/servers/route.ts` (GET handler)
- Modify: `src/app/api/servers/[id]/route.ts` (GET handler)

**Step 1: Update server list GET to filter by visibility**

In `src/app/api/servers/route.ts`, modify the `where` construction (around line 104-126):

- For non-owner queries, add `visibility: { not: "private" }` to exclude private servers from public listing
- For the response mapping, check membership for `unlisted` servers to decide whether to include `host`/`port`
- Add `visibility` and `joinMode` to the response fields

**Step 2: Update server detail GET to protect address**

In `src/app/api/servers/[id]/route.ts`, after fetching the server:

- Import and use `canSeeServerAddress` from `src/lib/server-membership.ts`
- If user cannot see address, replace `host` and `port` with `null` / `0` in the response
- Add `visibility`, `joinMode`, and `isMember` to the response

**Step 3: Verify**

```bash
pnpm tsc --noEmit && pnpm lint
```

**Step 4: Commit**

```bash
git add src/app/api/servers/route.ts src/app/api/servers/\[id\]/route.ts
git commit -m "feat: filter server list and protect address by visibility"
```

---

## Task 7: Server Settings API

**Files:**
- Create: `src/app/api/servers/[id]/settings/route.ts`

**Step 1: Implement PUT handler**

```typescript
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { isActiveUserError, requireActiveUser } from "@/lib/auth-guard";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { resolveServerCuid } from "@/lib/lookup";
import { requireServerOwner } from "@/lib/server-membership";
import { serverLookupIdSchema, updateServerSettingsSchema } from "@/lib/validation";
```

- Validate input with `updateServerSettingsSchema`
- Require authenticated + active user via `requireActiveUser()`
- Require server ownership via `requireServerOwner()`
- Update server `visibility`, `joinMode`, `applicationForm` fields
- Return updated settings

**Step 2: Verify**

```bash
pnpm tsc --noEmit && pnpm lint
```

**Step 3: Commit**

```bash
git add src/app/api/servers/\[id\]/settings/
git commit -m "feat: add server settings API for visibility and join mode"
```

---

## Task 8: Server Applications API

**Files:**
- Create: `src/app/api/servers/[id]/applications/route.ts` (GET list, POST apply)
- Create: `src/app/api/servers/[id]/applications/[appId]/route.ts` (PUT review)

**Step 1: Implement POST /api/servers/{id}/applications (player apply)**

- Require auth via `requireActiveUser()`
- Validate input with `createApplicationSchema`
- Check server exists, `joinMode` allows applications
- Check no existing pending application (unique constraint)
- Create `ServerApplication` record
- Return 201

**Step 2: Implement GET /api/servers/{id}/applications (owner list)**

- Require auth + server ownership
- Paginate with `queryApplicationsSchema`
- Join user info for display
- Return application list with pagination

**Step 3: Implement PUT /api/servers/{id}/applications/{appId} (owner review)**

- Require auth + server ownership
- Validate with `reviewApplicationSchema`
- On approve:
  - Update application status to `approved`
  - Create `ServerMember` record
  - Create `WhitelistSync` record (status: `pending`, action: `add`)
  - Publish `whitelist:change` event to Redis
  - Create notification for the applicant
- On reject:
  - Update application status to `rejected`
  - Create notification for the applicant

**Step 4: Verify**

```bash
pnpm tsc --noEmit && pnpm lint
```

**Step 5: Commit**

```bash
git add src/app/api/servers/\[id\]/applications/
git commit -m "feat: add server application API (apply, list, review)"
```

---

## Task 9: Server Invites API

**Files:**
- Create: `src/app/api/servers/[id]/invites/route.ts` (GET list, POST create)
- Create: `src/app/api/servers/[id]/invites/[code]/route.ts` (DELETE revoke)
- Create: `src/app/api/servers/[id]/join/[code]/route.ts` (POST join by invite)

**Step 1: Implement POST /api/servers/{id}/invites (create invite)**

- Require auth + server ownership
- Validate with `createInviteSchema`
- Generate unique invite code (8-char alphanumeric via `crypto.randomBytes`)
- Create `ServerInvite` record with optional `maxUses` and `expiresAt`
- Return invite code and URL

**Step 2: Implement GET /api/servers/{id}/invites (list)**

- Require auth + server ownership
- Return all active invites for the server

**Step 3: Implement DELETE /api/servers/{id}/invites/{code} (revoke)**

- Require auth + server ownership
- Delete the invite record

**Step 4: Implement POST /api/servers/{id}/join/{code} (player join)**

- Require auth via `requireActiveUser()`
- Validate invite code exists, not expired, not max uses reached
- Validate `mcUsername` with `joinByInviteSchema`
- Create `ServerMember` record (joinedVia: `invite`)
- Increment `usedCount` on invite
- Create `WhitelistSync` record (status: `pending`, action: `add`)
- Publish `whitelist:change` event to Redis
- Return success with server address (now visible as member)

**Step 5: Verify**

```bash
pnpm tsc --noEmit && pnpm lint
```

**Step 6: Commit**

```bash
git add src/app/api/servers/\[id\]/invites/ src/app/api/servers/\[id\]/join/
git commit -m "feat: add server invite API (create, list, revoke, join)"
```

---

## Task 10: Server Members API

**Files:**
- Create: `src/app/api/servers/[id]/members/route.ts` (GET list)
- Create: `src/app/api/servers/[id]/members/[memberId]/route.ts` (DELETE remove)
- Create: `src/app/api/servers/[id]/membership/route.ts` (GET own status)

**Step 1: Implement GET /api/servers/{id}/members (owner list)**

- Require auth + server ownership
- Paginate with `queryMembersSchema`
- Join user info + latest sync status
- Return member list

**Step 2: Implement DELETE /api/servers/{id}/members/{memberId} (remove)**

- Require auth + server ownership
- Create `WhitelistSync` record (action: `remove`, status: `pending`)
- Publish `whitelist:change` event to Redis
- Delete the `ServerMember` record
- Return success

**Step 3: Implement GET /api/servers/{id}/membership (player's own status)**

- Require auth via `requireActiveUser()`
- Check `ServerMember` exists for this user + server
- Check `ServerApplication` exists for this user + server
- Return `MembershipStatus`

**Step 4: Verify**

```bash
pnpm tsc --noEmit && pnpm lint
```

**Step 5: Commit**

```bash
git add src/app/api/servers/\[id\]/members/ src/app/api/servers/\[id\]/membership/
git commit -m "feat: add server members API (list, remove, own status)"
```

---

## Task 11: API Key Management API

**Files:**
- Create: `src/app/api/servers/[id]/api-key/route.ts`

**Step 1: Implement POST handler (generate/reset API key)**

- Require auth + server ownership
- Generate API key via `generateApiKey()` from `src/lib/api-key.ts`
- Store hash in `server.apiKeyHash`
- Return the raw key (shown once only)

**Step 2: Verify**

```bash
pnpm tsc --noEmit && pnpm lint
```

**Step 3: Commit**

```bash
git add src/app/api/servers/\[id\]/api-key/
git commit -m "feat: add API key management for plugin auth"
```

---

## Task 12: Whitelist Sync APIs (Plugin Communication)

**Files:**
- Create: `src/app/api/servers/[id]/sync/handshake/route.ts`
- Create: `src/app/api/servers/[id]/sync/pending/route.ts`
- Create: `src/app/api/servers/[id]/sync/status/route.ts`
- Create: `src/app/api/sync/[syncId]/ack/route.ts`
- Create: `src/lib/plugin-auth.ts`

**Step 1: Create plugin auth middleware**

`src/lib/plugin-auth.ts`:

```typescript
import { prisma } from "@/lib/db";
import { hashApiKey } from "@/lib/api-key";

/** Authenticate a plugin request via API key in Authorization header. Returns serverId or null. */
export async function authenticatePlugin(
  request: Request,
  expectedServerId: string,
): Promise<boolean> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;

  const raw = authHeader.slice(7);
  const hash = hashApiKey(raw);

  const server = await prisma.server.findUnique({
    where: { id: expectedServerId },
    select: { apiKeyHash: true },
  });

  return server?.apiKeyHash === hash;
}
```

**Step 2: Implement POST /api/servers/{id}/sync/handshake**

- Authenticate via `authenticatePlugin()`
- Return current full whitelist (all `ServerMember` mc_username values)
- Return all pending/failed `WhitelistSync` records
- Return WebSocket URL (`ws://<host>/ws?serverId={id}&token={apiKey}`)
- Mark the server as "plugin connected" in Redis (for console status display)

**Step 3: Implement POST /api/sync/{syncId}/ack**

- Authenticate via API key (extract serverId from the sync record)
- Update `WhitelistSync` status to `acked`, set `ackedAt`

**Step 4: Implement GET /api/servers/{id}/sync/pending**

- Authenticate via `authenticatePlugin()`
- Return all `WhitelistSync` records with status `pending` or `failed`

**Step 5: Implement GET /api/servers/{id}/sync/status (owner console)**

- Require auth + server ownership
- Return `SyncStatusOverview`: connected status (from Redis), pending/failed counts, recent syncs

**Step 6: Verify**

```bash
pnpm tsc --noEmit && pnpm lint
```

**Step 7: Commit**

```bash
git add src/lib/plugin-auth.ts src/app/api/servers/\[id\]/sync/ src/app/api/sync/
git commit -m "feat: add whitelist sync APIs for plugin communication"
```

---

## Task 13: Redis Pub/Sub for Whitelist Changes

**Files:**
- Create: `src/lib/whitelist-pubsub.ts`

**Step 1: Create pub/sub helpers**

```typescript
import { getRedisConnection } from "@/lib/redis";

export const WHITELIST_CHANNEL = "whitelist:change";

export interface WhitelistChangeMessage {
  serverId: string;
  syncId: string;
  action: "add" | "remove";
  mcUsername: string;
}

/** Publish a whitelist change event. */
export async function publishWhitelistChange(message: WhitelistChangeMessage): Promise<void> {
  const redis = getRedisConnection();
  await redis.publish(WHITELIST_CHANNEL, JSON.stringify(message));
}
```

**Step 2: Update Task 8 and Task 9 to use `publishWhitelistChange()`**

Wherever a `WhitelistSync` record is created, call `publishWhitelistChange()` afterward.

**Step 3: Verify**

```bash
pnpm tsc --noEmit
```

**Step 4: Commit**

```bash
git add src/lib/whitelist-pubsub.ts
git commit -m "feat: add Redis pub/sub for whitelist change events"
```

---

## Task 14: WebSocket Server

**Files:**
- Create: `src/ws/index.ts`
- Create: `src/ws/connections.ts`

**Step 1: Create connection manager**

`src/ws/connections.ts` — Manages WebSocket connections per serverId:

```typescript
import type { WebSocket } from "ws";

/** Map of serverId -> Set of connected WebSocket clients */
const connections = new Map<string, Set<WebSocket>>();

export function addConnection(serverId: string, ws: WebSocket): void {
  if (!connections.has(serverId)) {
    connections.set(serverId, new Set());
  }
  connections.get(serverId)!.add(ws);
}

export function removeConnection(serverId: string, ws: WebSocket): void {
  const set = connections.get(serverId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) connections.delete(serverId);
  }
}

export function getConnections(serverId: string): Set<WebSocket> | undefined {
  return connections.get(serverId);
}

export function isServerConnected(serverId: string): boolean {
  const set = connections.get(serverId);
  return set !== undefined && set.size > 0;
}
```

**Step 2: Create WS server entrypoint**

`src/ws/index.ts`:

- Create HTTP server + WebSocket server (using `ws` library)
- On connection: validate API key from query params, add to connection map
- Subscribe to Redis `whitelist:change` channel
- On Redis message: parse, find connections for serverId, send to all connected plugins
- Implement heartbeat (ping/pong every 30s)
- Handle disconnection cleanup
- Graceful shutdown on SIGTERM/SIGINT

Key structure:

```typescript
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import Redis from "ioredis";
import { PrismaClient } from "@prisma/client";
import { addConnection, removeConnection, getConnections } from "./connections";

const PORT = Number(process.env.WS_PORT || 3001);
const prisma = new PrismaClient();
// Redis subscriber (separate connection for pub/sub)
// HTTP server for health check
// WS upgrade with API key auth
// Redis subscribe to WHITELIST_CHANNEL
// Heartbeat interval
// Graceful shutdown
```

**Step 3: Add `ws` dependency**

```bash
pnpm add ws && pnpm add -D @types/ws
```

**Step 4: Add build and dev scripts to package.json**

```json
"ws": "tsx src/ws/index.ts",
"ws:dev": "tsx watch src/ws/index.ts",
"build:ws": "node -e \"require('esbuild').buildSync({entryPoints:['src/ws/index.ts'],bundle:true,platform:'node',target:'node24',outfile:'dist/ws-server.js',tsconfig:'tsconfig.json',external:['@prisma/client']})\"",
```

**Step 5: Verify**

```bash
pnpm tsc --noEmit && pnpm lint
```

**Step 6: Commit**

```bash
git add src/ws/ package.json pnpm-lock.yaml
git commit -m "feat: add standalone WebSocket server for whitelist sync"
```

---

## Task 15: Update Dockerfile & Deployment

**Files:**
- Modify: `Dockerfile`

**Step 1: Add WS server build to Dockerfile builder stage**

After the existing esbuild command for worker (line ~28-35), add:

```dockerfile
RUN esbuild src/ws/index.ts \
    --bundle \
    --platform=node \
    --target=node24 \
    --outfile=dist/ws-server.js \
    --tsconfig=tsconfig.json \
    --external:@prisma/client
```

**Step 2: Copy WS server bundle to runner stage**

After the worker.js COPY line (line ~52), add:

```dockerfile
COPY --from=builder --chown=nextjs:nodejs /app/dist/ws-server.js ./ws-server.js
```

**Step 3: Add WS_PORT env var**

```dockerfile
ENV WS_PORT=3001
EXPOSE 3001
```

**Step 4: Verify Dockerfile builds**

```bash
# Local verification (just check syntax, full build on CI)
pnpm tsc --noEmit
```

**Step 5: Commit**

```bash
git add Dockerfile
git commit -m "feat: add WS server build to Dockerfile"
```

---

## Task 16: Update Notification Types

**Files:**
- Modify: `src/lib/types.ts`

**Step 1: Extend NotificationType**

Update the `NotificationType` union (line ~128):

```typescript
export type NotificationType =
  | "comment_reply"
  | "server_online"
  | "server_approved"
  | "server_rejected"
  | "application_approved"
  | "application_rejected"
  | "member_removed"
  | "whitelist_sync_failed";
```

**Step 2: Verify**

```bash
pnpm tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: add notification types for membership events"
```

---

## Task 17: Console UI — Server Settings Panel

**Files:**
- Create: `src/components/console/ServerSettings.tsx`
- Modify: `src/app/console/[serverId]/page.tsx`

**Step 1: Create ServerSettings component**

A form component that allows the server owner to:
- Toggle `visibility` (public/private/unlisted) via radio or select
- Toggle `joinMode` (open/apply/invite/apply_and_invite) via radio or select
- Configure `applicationForm` fields (dynamic form builder with add/remove/reorder)
- Save via `PUT /api/servers/{id}/settings`

Use the existing M3 design tokens (teal accents, rounded-xl cards, etc.).

**Step 2: Add to console page**

Import and render `<ServerSettings>` in `src/app/console/[serverId]/page.tsx`, likely as a new section after `ServerActions`.

**Step 3: Verify**

```bash
pnpm tsc --noEmit && pnpm lint
```

**Step 4: Commit**

```bash
git add src/components/console/ServerSettings.tsx src/app/console/\[serverId\]/page.tsx
git commit -m "feat: add server privacy settings UI in console"
```

---

## Task 18: Console UI — Applications Management

**Files:**
- Create: `src/components/console/ApplicationList.tsx`
- Modify: `src/app/console/[serverId]/page.tsx`

**Step 1: Create ApplicationList component**

- Fetch from `GET /api/servers/{id}/applications?status=pending`
- Display each application: user avatar, name, MC username, form answers, timestamp
- Approve / Reject buttons that call `PUT /api/servers/{id}/applications/{appId}`
- Tab filter for status (pending / approved / rejected)
- Pagination

**Step 2: Add to console page**

Render `<ApplicationList>` conditionally when `joinMode` includes `apply`.

**Step 3: Verify**

```bash
pnpm tsc --noEmit && pnpm lint
```

**Step 4: Commit**

```bash
git add src/components/console/ApplicationList.tsx src/app/console/\[serverId\]/page.tsx
git commit -m "feat: add application management UI in console"
```

---

## Task 19: Console UI — Invite & Member Management

**Files:**
- Create: `src/components/console/InviteManager.tsx`
- Create: `src/components/console/MemberList.tsx`
- Modify: `src/app/console/[serverId]/page.tsx`

**Step 1: Create InviteManager component**

- Create invite form (max uses, expiration)
- List active invites with copy-link button
- Revoke invite button

**Step 2: Create MemberList component**

- List members with avatar, name, MC username, join method, sync status indicator
- Remove member button (with confirmation)

**Step 3: Add both to console page**

Render conditionally based on `joinMode`.

**Step 4: Verify**

```bash
pnpm tsc --noEmit && pnpm lint
```

**Step 5: Commit**

```bash
git add src/components/console/InviteManager.tsx src/components/console/MemberList.tsx src/app/console/\[serverId\]/page.tsx
git commit -m "feat: add invite and member management UI in console"
```

---

## Task 20: Console UI — API Key & Sync Status

**Files:**
- Create: `src/components/console/ApiKeyManager.tsx`
- Create: `src/components/console/SyncStatus.tsx`
- Modify: `src/app/console/[serverId]/page.tsx`

**Step 1: Create ApiKeyManager component**

- Show masked API key status (generated or not)
- "Generate" / "Reset" button that calls `POST /api/servers/{id}/api-key`
- Show the raw key once after generation with copy button
- Warning about key being shown only once

**Step 2: Create SyncStatus component**

- Fetch from `GET /api/servers/{id}/sync/status`
- Show connection status (green/red indicator)
- Show pending/failed sync counts
- Recent sync records table with status badges

**Step 3: Add to console page**

**Step 4: Verify**

```bash
pnpm tsc --noEmit && pnpm lint
```

**Step 5: Commit**

```bash
git add src/components/console/ApiKeyManager.tsx src/components/console/SyncStatus.tsx src/app/console/\[serverId\]/page.tsx
git commit -m "feat: add API key and sync status UI in console"
```

---

## Task 21: Player UI — Server Detail Page Updates

**Files:**
- Modify: `src/app/servers/[id]/page.tsx`

**Step 1: Update server detail page**

- For `unlisted` servers: show badge "needs application", hide address, show apply/join button
- For `private` servers reached via invite link: show apply/join form
- For members: show full address as normal
- Add membership status section (fetch from `GET /api/servers/{id}/membership`)
- Add "Apply to Join" button/form when applicable
- Show application status if already applied

**Step 2: Verify**

```bash
pnpm tsc --noEmit && pnpm lint
```

**Step 3: Commit**

```bash
git add src/app/servers/\[id\]/page.tsx
git commit -m "feat: update server detail page for private server support"
```

---

## Task 22: Player UI — Application Form

**Files:**
- Create: `src/components/ApplicationForm.tsx`

**Step 1: Create dynamic application form component**

- Render form fields based on server's `applicationForm` config
- Support text, textarea, select, multiselect field types
- MC username input (always required)
- Submit via `POST /api/servers/{id}/applications`
- Show success/error state

**Step 2: Verify**

```bash
pnpm tsc --noEmit && pnpm lint
```

**Step 3: Commit**

```bash
git add src/components/ApplicationForm.tsx
git commit -m "feat: add dynamic application form component"
```

---

## Task 23: Player UI — Invite Join Page

**Files:**
- Create: `src/app/servers/[id]/join/[code]/page.tsx`

**Step 1: Create invite join page**

- Show server name and basic info
- MC username input form
- Submit via `POST /api/servers/{id}/join/{code}`
- Handle expired/invalid invite errors
- Redirect to server detail on success

**Step 2: Verify**

```bash
pnpm tsc --noEmit && pnpm lint
```

**Step 3: Commit**

```bash
git add src/app/servers/\[id\]/join/
git commit -m "feat: add invite join page"
```

---

## Task 24: Server List UI Updates

**Files:**
- Modify: `src/app/servers/page.tsx` (or the component rendering the server list)

**Step 1: Update server card display**

- For `unlisted` servers: show "Requires Application" badge, hide address on card
- Ensure `private` servers don't appear in list
- Show membership badge for servers the user has joined

**Step 2: Verify**

```bash
pnpm tsc --noEmit && pnpm lint
```

**Step 3: Commit**

```bash
git add src/app/servers/
git commit -m "feat: update server list UI for visibility badges"
```

---

## Task 25: Final Verification & Cleanup

**Step 1: Run full checks**

```bash
pnpm lint
pnpm tsc --noEmit
pnpm build
```

**Step 2: Fix any errors**

**Step 3: Final commit**

```bash
git add -A
git commit -m "chore: fix lint and type errors from private server feature"
```

---

## Execution Notes

### Dependencies to install

```bash
pnpm add ws
pnpm add -D @types/ws
```

### New environment variables

```
WS_PORT=3001          # WebSocket server port
WS_PUBLIC_URL=ws://... # Public WebSocket URL (for plugins)
```

### Development workflow

Three terminals needed:
1. `pnpm dev` — Next.js
2. `pnpm worker:dev` — BullMQ Worker
3. `pnpm ws:dev` — WebSocket Server

### Task dependency graph

```
Task 1 (Schema) ─────┬──> Task 2 (Validation)
                      ├──> Task 3 (Types)
                      └──> Task 4 (API Key) ──> Task 11 (API Key API) ──> Task 12 (Sync APIs)
                                                                              │
Task 5 (Membership) ──> Task 6 (Modify existing APIs)                        │
                                                                              v
Task 2 ──> Task 7 (Settings API)                                    Task 13 (Pub/Sub) ──> Task 14 (WS Server)
Task 2 ──> Task 8 (Applications API)                                                          │
Task 2 ──> Task 9 (Invites API)                                                               v
Task 2 ──> Task 10 (Members API)                                                    Task 15 (Dockerfile)

Task 16 (Notification types) — independent

Tasks 7-12 ──> Tasks 17-24 (UI tasks, can be parallelized)

Task 25 (Final verification) — depends on all above
```

### Parallelizable task groups

- **Group A (independent):** Tasks 2, 3, 4, 5, 16 — all depend only on Task 1
- **Group B (APIs):** Tasks 7, 8, 9, 10, 11 — depend on Group A, independent of each other
- **Group C (Sync infra):** Tasks 12, 13, 14, 15 — sequential chain
- **Group D (UI):** Tasks 17-24 — depend on their respective APIs, can be parallelized within group
