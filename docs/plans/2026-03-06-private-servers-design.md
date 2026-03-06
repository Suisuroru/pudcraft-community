# 私域服务器 + 白名单同步 设计文档

> 日期: 2026-03-06
> 状态: 已确认，待实施

## 背景

Pudcraft Community 当前所有服务器均为公开可见。部分服务器不对外开放，有自己的小圈子，希望通过审核筛选玩家。平台需要支持私域服务器功能，并通过 Bukkit 插件/Fabric 模组实现白名单自动同步。

## 整体路线图

1. **私域服务器 + 白名单同步**（本文档）
2. **数据公开化** — 在线人数历史、延迟等数据从服主控制台移到服务器公开页面
3. **LLM 推荐系统** — 智能 Feed（个性化推荐）+ 对话式自然语言搜索

## 一、数据模型变更

### Server 模型新增字段

```
visibility: "public" | "private" | "unlisted"
  - public: 现有行为，完全公开
  - private: 公开列表不可见，仅通过邀请链接/申请可达
  - unlisted: 列表中可见名称和简介，但地址隐藏，需申请/邀请

joinMode: "open" | "apply" | "invite" | "apply_and_invite"
  - open: 无需申请（现有行为）
  - apply: 申请制
  - invite: 邀请制
  - apply_and_invite: 两者并行

applicationForm: JSON?  — 服主自定义的申请表字段配置
apiKey: String?         — 插件通信密钥（哈希存储）
```

### 新增模型

```prisma
ServerApplication — 玩家入服申请
  id, serverId, userId, status(pending/approved/rejected/cancelled),
  formData(JSON), reviewNote?, reviewedBy?, createdAt, updatedAt

ServerInvite — 邀请码/链接
  id, serverId, code(unique), createdBy,
  maxUses?, usedCount, expiresAt?, createdAt

ServerMember — 已通过的成员
  id, serverId, userId, joinedVia("apply"|"invite"),
  mcUsername?, createdAt

WhitelistSync — 白名单同步记录
  id, serverId, memberId, action("add"|"remove"),
  status("pending"|"pushed"|"acked"|"failed"),
  retryCount, lastAttemptAt, ackedAt, createdAt
```

## 二、白名单同步架构

### 通信方式

- **插件 -> 平台**: HTTP API（注册、ACK 确认、上线拉取）
- **平台 -> 插件**: WebSocket 推送（白名单变更通知）

### 认证

服主在控制台生成 API Key（绑定到具体服务器），插件配置文件中填入。API Key 哈希存储。

### 同步流程

```
1. 插件启动 -> HTTP POST /api/servers/{id}/sync/handshake
   - 携带 API Key + 插件版本
   - 平台返回当前完整白名单列表 + WebSocket 连接地址
   - 插件用该列表覆盖本地白名单

2. 插件建立 WebSocket 长连接，保持心跳

3. 平台审核通过玩家申请 ->
   a. WhitelistSync 记录创建 (status: pending)
   b. 通过 WebSocket 推送 { action: "add", mcUsername, syncId }
   c. 插件执行白名单操作 -> HTTP POST /api/sync/{syncId}/ack
   d. 平台收到 ACK -> status: acked

4. WebSocket 断开或推送无 ACK ->
   a. 短期：指数退避重试 3 次（5s, 15s, 45s）
   b. 超时：标记 status: failed，控制台显示同步失败提醒
   c. 插件重新上线 -> 步骤 1 的 handshake 自动补齐所有 pending/failed 记录

5. 服主控制台实时显示每条同步记录的状态
```

## 三、系统架构

```
Docker Compose
  +-----------+  +----------+  +-----------+
  |  Next.js  |  |  Worker  |  | WS Server |
  |  (web)    |  | (BullMQ) |  |   (ws)    |
  +-----+-----+  +----+-----+  +-----+-----+
        |              |              |
        +------+-------+------+------+
               |              |
          +----+----+    +----+----+
          |PostgreSQL|    |  Redis  |
          |         |    |(pub/sub |
          |         |    |+ BullMQ)|
          +---------+    +---------+
```

**数据流：**
1. 服主审批申请 -> Next.js 写入 DB + Redis PUBLISH
2. WS Server 收到 Redis 消息 -> 推送给对应服务器的插件
3. 插件执行白名单操作 -> HTTP POST ACK 到 Next.js API
4. Next.js 更新 WhitelistSync 状态 -> 控制台实时可见

**WS Server**: 独立 Node.js 进程，使用 `ws` 库，通过 Redis pub/sub 与主应用解耦。部署为 Docker Compose 中的独立容器。

## 四、API 设计

### 私域管理（服主）

```
PUT    /api/servers/{id}/settings                — 更新 visibility、joinMode、applicationForm
POST   /api/servers/{id}/invites                 — 生成邀请码
GET    /api/servers/{id}/invites                 — 邀请码列表
DELETE /api/servers/{id}/invites/{code}           — 撤销邀请码
GET    /api/servers/{id}/applications             — 申请列表（分页）
PUT    /api/servers/{id}/applications/{appId}     — 审批（approve/reject + reviewNote）
GET    /api/servers/{id}/members                  — 成员列表
DELETE /api/servers/{id}/members/{memberId}       — 移除成员
```

### 白名单同步（插件）

```
POST /api/servers/{id}/sync/handshake  — 插件上线握手，返回完整白名单 + WS 地址
POST /api/sync/{syncId}/ack            — 插件确认同步完成
GET  /api/servers/{id}/sync/pending    — 备用：插件主动拉取未同步记录
```

### 白名单同步管理（服主）

```
POST /api/servers/{id}/api-key       — 生成/重置 API Key
GET  /api/servers/{id}/sync/status   — 同步状态总览
```

### 玩家

```
POST /api/servers/{id}/apply          — 提交入服申请
POST /api/servers/{id}/join/{code}    — 使用邀请码加入
GET  /api/servers/{id}/membership     — 查询自己的成员状态
```

### 现有 API 变更

- `GET /api/servers` 和 `GET /api/servers/{id}` — 根据 visibility 和用户身份过滤地址字段

## 五、用户体验流程

### 服主

1. 控制台切换 visibility 和 joinMode
2. 自定义申请表字段（申请制）
3. 生成邀请码，可设有效期和最大使用次数（邀请制）
4. 审核申请列表，通过后自动触发白名单同步
5. 成员管理：查看成员、同步状态，可手动移除
6. 生成 API Key 用于插件配置

### 玩家

1. unlisted 服务器在列表可见但标注"需申请"；private 服务器通过邀请链接到达
2. 申请制：填写申请表，提交后等待审核
3. 邀请制：通过链接直接加入
4. 申请通过/拒绝时收到站内通知
5. 白名单自动生效，无需手动操作

### 地址保护

- private / unlisted 服务器的 host:port 仅对已通过的 ServerMember 可见
- API 层面做权限校验，未授权请求不返回地址字段

## 六、插件/模组

- 支持 Bukkit/Paper（插件）和 Fabric/Forge（模组）
- 配置文件：`apiKey` + `platformUrl`
- 完全开源，服主可自行审查代码
- Java/Kotlin 实现，使用原生 WebSocket 客户端
