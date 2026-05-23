# Enterprise Control Plane (ECP) Architecture Design

## Context

clawdbot 当前缺乏集中管控能力。各 Gateway 实例独立运行，无法从中心统一下发策略、版本更新或紧急禁令。本方案设计一个独立部署的企业管控平面服务，通过 WebSocket 长连接主动推送策略到所有 Gateway 实例，覆盖 Gateway + Agent + 终端用户全链路。

## 架构概览

```
┌─────────────────────────────────────────────────┐
│          Enterprise Control Plane (ECP)          │
│  Port: 19001 (Admin API) + 19000 (WS for Fleet) │
│  Store: SQLite → PostgreSQL                      │
├─────────────────────────────────────────────────┤
│  Admin HTTP API │ Policy Engine │ Fleet Registry │
└────────┬────────────────┬───────────────────────┘
         │  WebSocket (Push)
    ┌────▼────┐      ┌────▼────┐
    │Gateway A│      │Gateway B│
    │(ECP SDK)│      │(ECP SDK)│
    └─────────┘      └─────────┘
```

## 设计决策

| 维度      | 决策                            | 原因                                   |
| --------- | ------------------------------- | -------------------------------------- |
| 通信模式  | Push (WebSocket 长连接)         | 策略变更需实时生效，紧急操作不容许延迟 |
| 部署形态  | 独立服务 (新进程)               | 管控面与数据面解耦，独立扩容和运维     |
| 管控范围  | 全链路 (Gateway + Agent + 用户) | 企业场景需要端到端管控能力             |
| 租户模型  | 单组织                          | 面向单一企业内部，简化设计             |
| 存储      | SQLite (可升级 PostgreSQL)      | 起步简单，接口抽象支持后续切换         |
| HTTP 框架 | Hono                            | 项目已有依赖，轻量高性能               |
| Schema    | TypeBox                         | 与现有 Gateway 协议模式一致            |

## 目录结构

```
src/enterprise-control-plane/
├── index.ts                    # 服务入口
├── server.ts                   # HTTP + WS 服务器启动
├── types.ts                    # 共享类型
├── protocol/
│   ├── schemas.ts              # TypeBox 消息 schema
│   └── frames.ts              # 帧类型定义
├── store/
│   ├── index.ts               # 存储接口抽象
│   ├── sqlite.ts              # SQLite 实现
│   └── migrations.ts          # 迁移管理
├── registry/
│   ├── gateway-registry.ts    # 已连接 Gateway 注册表
│   └── heartbeat.ts           # 心跳处理 + 过期检测
├── policy/
│   ├── engine.ts              # 策略评估引擎
│   ├── types.ts               # 策略规则类型
│   ├── compiler.ts            # 规则编译为评估闭包
│   └── merge.ts               # 优先级合并逻辑
├── config/
│   └── push.ts                # 配置补丁构建 + 推送编排
├── version-manager/
│   └── index.ts               # 版本追踪 + 升级编排
├── audit/
│   ├── logger.ts              # 审计日志写入
│   └── types.ts               # 审计事件类型
├── api/
│   ├── router.ts              # Admin HTTP 路由 (Hono)
│   ├── gateways.ts            # 舰队管理端点
│   ├── policies.ts            # 策略 CRUD
│   ├── versions.ts            # 版本管理
│   ├── emergency.ts           # 紧急控制
│   └── audit.ts               # 审计查询
└── gateway-client/
    ├── index.ts               # 客户端 SDK 入口 (嵌入 Gateway 进程)
    ├── connection.ts          # WS 连接 + 重连
    ├── handler.ts             # 入站消息分发
    └── enforcement.ts         # 策略执行 (注册到 Hook 系统)
```

## 协议设计

### Gateway → ECP

| 帧类型          | 说明         | 触发时机           |
| --------------- | ------------ | ------------------ |
| `ecp.register`  | 上线注册     | 连接建立后立即发送 |
| `ecp.heartbeat` | 心跳         | 每 30s             |
| `ecp.ack`       | 确认应答     | 收到 ECP 推送后    |
| `ecp.audit`     | 审计事件上报 | 策略执行触发时     |

### ECP → Gateway

| 帧类型               | 说明     | 触发时机        |
| -------------------- | -------- | --------------- |
| `ecp.welcome`        | 连接欢迎 | register 后响应 |
| `ecp.policy.push`    | 策略推送 | 策略变更时      |
| `ecp.config.push`    | 配置补丁 | 管理员操作时    |
| `ecp.version.notify` | 版本通知 | 新版本发布时    |
| `ecp.emergency`      | 紧急操作 | 管理员触发时    |

### 连接生命周期

```
Gateway 启动
  → WS 连接 ECP (wss://ecp:19000)
  → 发送 ecp.register { gatewayId, version, configHash, capabilities }
  ← 接收 ecp.welcome { policyVersion, policies[], configOverrides }
  → 每 30s 发送 ecp.heartbeat { clientCount, sessionCount, policyVersion }
  ← 随时接收 policy/config/version/emergency 推送
  → 每次推送回复 ecp.ack { requestId, ok }
```

### 消息结构示例

```typescript
// Gateway 注册
{
  type: "ecp.register",
  gatewayId: "gw-prod-001",
  version: "2024.5.23",
  hostname: "gateway-prod-1.internal",
  port: 18789,
  configHash: "sha256:abc123...",
  capabilities: ["hooks", "acp", "webchat"],
  connectedClients: 42,
  activeAgentSessions: 8,
  startedAt: 1716451200000
}

// 策略推送
{
  type: "ecp.policy.push",
  requestId: "req-uuid-001",
  policyVersion: 15,
  mode: "replace",
  policies: [
    {
      id: "pol-001",
      name: "block-file-write-all",
      priority: 10,
      effect: "deny",
      scopeType: "tool",
      scopeTarget: "file_write*",
      conditions: {},
      enabled: true
    }
  ]
}

// 紧急操作
{
  type: "ecp.emergency",
  requestId: "req-uuid-002",
  action: "kill-tool",
  target: "shell_execute",
  reason: "security incident - unauthorized command execution detected"
}
```

## 数据模型

### gateways (舰队注册)

| 字段                  | 类型        | 说明                             |
| --------------------- | ----------- | -------------------------------- |
| id                    | TEXT PK     | 稳定 Gateway UUID                |
| hostname              | TEXT        | 主机名                           |
| port                  | INTEGER     | 端口                             |
| version               | TEXT        | 软件版本                         |
| config_hash           | TEXT        | 当前配置 SHA256                  |
| capabilities          | TEXT (JSON) | 能力列表                         |
| connected_clients     | INTEGER     | 已连接客户端数                   |
| active_agent_sessions | INTEGER     | 活跃 Agent 会话数                |
| policy_version        | INTEGER     | 已应用的策略版本                 |
| status                | TEXT        | connected / stale / disconnected |
| last_heartbeat_at     | INTEGER     | 最后心跳时间                     |

### policies (策略规则)

| 字段         | 类型        | 说明                                         |
| ------------ | ----------- | -------------------------------------------- |
| id           | TEXT PK     | UUID                                         |
| name         | TEXT UNIQUE | 策略名称                                     |
| priority     | INTEGER     | 优先级 (越低越高)                            |
| effect       | TEXT        | allow / deny / rate_limit                    |
| scope_type   | TEXT        | tool / plugin / prompt / model / file_access |
| scope_target | TEXT        | glob 匹配模式                                |
| conditions   | TEXT (JSON) | 条件: users, groups, gateways, timeWindow    |
| enabled      | INTEGER     | 启用状态                                     |
| version      | INTEGER     | 策略版本 (每次编辑递增)                      |

### config_overrides (配置覆盖)

| 字段           | 类型        | 说明                           |
| -------------- | ----------- | ------------------------------ |
| id             | TEXT PK     | UUID                           |
| target_gateway | TEXT        | NULL=全部, 否则指定 gateway id |
| path           | TEXT        | 配置路径 (e.g. "tools.deny")   |
| value          | TEXT (JSON) | 值                             |
| priority       | TEXT        | normal / override              |

### audit_log (审计日志)

| 字段       | 类型        | 说明              |
| ---------- | ----------- | ----------------- |
| id         | INTEGER PK  | 自增              |
| ts         | INTEGER     | 时间戳            |
| gateway_id | TEXT        | 来源 Gateway      |
| actor      | TEXT        | 操作者            |
| action     | TEXT        | 动作类型          |
| target     | TEXT        | 目标资源          |
| details    | TEXT (JSON) | 详情              |
| outcome    | TEXT        | success / failure |

## 策略引擎

### 规则结构

```typescript
type PolicyRule = {
  id: string;
  name: string;
  priority: number; // 数值越低优先级越高
  effect: "allow" | "deny" | "rate_limit";
  scopeType: "tool" | "plugin" | "prompt" | "model" | "file_access";
  scopeTarget: string; // glob 匹配: "web_*", "file_read", "*"
  conditions: {
    users?: string[]; // 用户 ID 列表
    groups?: string[]; // 用户组
    gateways?: string[]; // 指定 Gateway
    timeWindow?: {
      startHour: number; // UTC 小时
      endHour: number;
      daysOfWeek?: number[];
    };
  };
  rateLimitConfig?: {
    maxRequests: number;
    windowMs: number;
    action: "block" | "warn";
  };
  enabled: boolean;
};
```

### 评估算法

```
输入: PolicyRule[], EvalContext { userId, groups, gatewayId, scopeType, scopeTarget, timestamp }
输出: { effect, matchedRule?, reason }

1. 过滤 enabled=true 的规则
2. 按 priority 升序排列
3. 逐条检查:
   a. scopeType 匹配?
   b. scopeTarget glob 匹配?
   c. conditions 满足? (user/group/gateway/time)
4. 第一条命中 → 返回其 effect (first-match-wins)
5. 无命中 → 默认 allow
```

## Gateway Client SDK 集成

### 配置扩展

```toml
# ~/.openclaw/config.toml 新增
[gateway.enterprise]
controlPlaneUrl = "wss://ecp.internal:19000"
gatewayId = "gw-001"
authToken = "$secret:ecp_token"
heartbeatIntervalMs = 30000
disconnectedMode = "permissive"  # permissive | restrictive
```

### 策略执行 Hook 注册

通过现有 plugin hook 系统注册合成 Hook (`__ecp_policy__`, priority=0):

| 现有 Hook 点          | 策略 Scope | 执行动作             |
| --------------------- | ---------- | -------------------- |
| `before_tool_call`    | `tool`     | 阻止被拒绝的工具调用 |
| `before_agent_start`  | `model`    | 阻止/覆盖模型选择    |
| `before_prompt_build` | `prompt`   | 阻止敏感 prompt 模式 |
| `before_install`      | `plugin`   | 阻止插件激活         |

### 配置覆盖应用

ECP 推送的 config override 通过现有 `config.patch` RPC 机制应用:

- `priority: "override"` → 不可被本地配置覆盖
- `priority: "normal"` → 作为默认值，本地可覆盖

## 离线降级

### permissive 模式 (默认)

- 保持最后已知策略继续执行
- 配置覆盖不撤回
- 审计事件本地缓冲 (上限 10,000 条)，重连后刷回
- 健康状态标记 `ecp.disconnected`

### restrictive 模式

- 缓存策略超过阈值 (5min) 后新工具调用默认拒绝
- 已有 session 可继续但不能调新工具
- 指数退避重连 (5s→10s→20s→40s→60s max, with jitter)

### 冷启动缓存

`~/.openclaw/ecp-policy-cache.json` 持久化最后策略集，确保无 ECP 冷启动也有基线执行能力。

## Admin HTTP API

```
Base: http://ecp-host:19001/api/v1
Auth: Bearer token

# 舰队管理
GET    /gateways              - 列出所有 Gateway 实例
GET    /gateways/:id          - 详情 + 实时状态

# 策略管理
GET    /policies              - 策略列表
POST   /policies              - 创建策略
PUT    /policies/:id          - 更新策略
DELETE /policies/:id          - 删除策略
POST   /policies/evaluate     - 干跑评估 (测试用)
POST   /policies/push         - 强制推送到全部 Gateway

# 配置覆盖
GET    /config-overrides      - 列出配置覆盖
POST   /config-overrides      - 创建配置覆盖
DELETE /config-overrides/:id  - 撤销覆盖
POST   /config-overrides/push - 推送到 Gateway

# 版本管理
POST   /versions              - 发布新版本通知
POST   /versions/:id/push     - 推送版本通知

# 紧急控制
POST   /emergency/kill-tool        - 全局禁用工具
POST   /emergency/kill-plugin      - 全局禁用插件
POST   /emergency/disconnect-user  - 强制断开用户
POST   /emergency/pause-sessions   - 暂停所有 Agent 会话

# 审计
GET    /audit                 - 审计日志查询 (支持时间/网关/动作过滤)
```

## 实现阶段

| Phase | 内容                                | 预期产出                         |
| ----- | ----------------------------------- | -------------------------------- |
| 1     | 协议 + 存储 + Gateway Client 连接   | 注册/心跳/welcome 流程跑通       |
| 2     | Policy Engine + enforcement hook    | 策略评估 + 工具阻止生效          |
| 3     | Admin API + Config Push             | 管理员可通过 API 管理策略和配置  |
| 4     | Version Manager + Emergency + Audit | 版本推送、紧急操作、审计日志完整 |

## 风险与约束

| 风险                   | 缓解措施                                                |
| ---------------------- | ------------------------------------------------------- |
| ECP 单点故障           | permissive 降级 + 本地策略缓存                          |
| 策略推送延迟           | WebSocket 长连接 + 心跳确认策略版本                     |
| 配置冲突 (ECP vs 本地) | priority 字段区分 override/normal                       |
| 向后兼容               | controlPlaneUrl 为可选配置，不配置时完全不加载 ECP 模块 |
