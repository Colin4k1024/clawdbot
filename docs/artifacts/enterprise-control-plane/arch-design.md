# Enterprise Control Plane (ECP) Architecture Design — Rust

## Context

clawdbot 当前缺乏集中管控能力。各 Gateway 实例独立运行，无法从中心统一下发策略、版本更新或紧急禁令。本方案设计一个 **Rust 实现、独立部署** 的企业管控平面服务，通过 WebSocket 长连接主动推送策略到所有 Gateway 实例，覆盖 Gateway + Agent + 终端用户全链路。

### 关键约束

- 独立 Git 仓库（`openclaw-ecp`），独立构建/发布流水线
- Rust 实现：高性能、内存安全、低资源占用、亚秒启动
- 存储支持 PostgreSQL + MySQL 双后端

---

## 架构概览

```
┌─────────────────────────────────────────────────┐
│          Enterprise Control Plane (ECP)          │
│       Rust / axum / tokio / sqlx                 │
│  Port: 19001 (Admin API) + 19000 (WS for Fleet) │
│  Store: PostgreSQL / MySQL                       │
├─────────────────────────────────────────────────┤
│  Admin HTTP API │ Policy Engine │ Fleet Registry │
└────────┬────────────────┬───────────────────────┘
         │  WebSocket (Push)
    ┌────▼────┐      ┌────▼────┐
    │Gateway A│      │Gateway B│
    │(ECP SDK)│      │(ECP SDK)│
    └─────────┘      └─────────┘
```

---

## 设计决策

| 维度      | 决策                              | 原因                                     |
| --------- | --------------------------------- | ---------------------------------------- |
| 语言      | Rust                              | 高性能、内存安全、单二进制部署、亚秒启动 |
| 通信模式  | Push (WebSocket 长连接)           | 策略变更需实时生效，紧急操作不容许延迟   |
| 部署形态  | 独立服务 (独立仓库)               | 管控面与数据面完全解耦，独立迭代和运维   |
| 管控范围  | 全链路 (Gateway + Agent + 用户)   | 企业场景需要端到端管控能力               |
| 租户模型  | 单组织                            | 面向单一企业内部，简化设计               |
| 存储      | PostgreSQL + MySQL (feature flag) | 企业环境常见数据库，sqlx 双后端支持      |
| HTTP 框架 | axum                              | tokio 生态原生，Tower 中间件，类型安全   |
| 序列化    | serde + serde_json                | 零成本抽象，与 Gateway JSON 协议兼容     |

---

## 技术选型

| 维度       | 选择                              | 原因                       |
| ---------- | --------------------------------- | -------------------------- |
| 异步运行时 | tokio                             | Rust 异步生态事实标准      |
| HTTP       | axum                              | Tower 中间件、类型安全路由 |
| WebSocket  | axum 内建 WS + tokio-tungstenite  | 与 HTTP 共享端口           |
| 序列化     | serde + serde_json                | 零成本、JSON 协议兼容      |
| 数据库     | sqlx (PostgreSQL + MySQL feature) | 编译期 SQL 校验，async     |
| SQL 构建   | sea-query                         | 跨 PG/MySQL 方言           |
| 迁移       | sqlx-cli                          | 原生集成                   |
| 配置       | config-rs + TOML                  | 分层配置                   |
| 日志       | tracing + tracing-subscriber      | 结构化日志                 |
| 认证       | jsonwebtoken                      | JWT Bearer token           |
| Glob       | globset                           | 策略 scope_target 匹配     |
| CLI        | clap                              | 标准 Rust CLI              |

---

## 仓库结构

```
openclaw-ecp/
├── Cargo.toml                    # workspace root
├── Cargo.lock
├── Dockerfile
├── docker-compose.yml
├── config/
│   ├── default.toml
│   └── production.toml
├── migrations/
│   ├── postgres/
│   │   └── 001_init.up.sql
│   └── mysql/
│       └── 001_init.up.sql
├── crates/
│   ├── ecp-server/               # 主服务二进制
│   │   └── src/
│   │       ├── main.rs
│   │       ├── app.rs
│   │       ├── config.rs
│   │       └── error.rs
│   ├── ecp-core/                 # 核心业务逻辑（纯逻辑，无 IO）
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── policy/           # 策略引擎
│   │       ├── protocol/         # 帧定义 + 认证
│   │       └── domain/           # 实体类型
│   ├── ecp-store/                # 存储层抽象 + 实现
│   │   └── src/
│   │       ├── lib.rs            # Store trait
│   │       ├── postgres.rs
│   │       └── mysql.rs
│   ├── ecp-fleet/                # 舰队管理（WS 连接池）
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── registry.rs
│   │       ├── connection.rs
│   │       ├── heartbeat.rs
│   │       └── broadcaster.rs
│   └── ecp-api/                  # HTTP API
│       └── src/
│           ├── lib.rs
│           ├── middleware/
│           ├── routes/
│           └── dto/
└── tests/
    └── integration/
```

---

## 协议设计

### Gateway → ECP

| 帧类型          | 说明         | 触发时机           |
| --------------- | ------------ | ------------------ |
| `ecp.register`  | 上线注册     | 连接建立后立即发送 |
| `ecp.heartbeat` | 心跳         | 每 30s             |
| `ecp.ack`       | 确认应答     | 收到 ECP 推送后    |
| `ecp.audit`     | 审计事件上报 | 策略执行触发时     |

### ECP → Gateway

| 帧类型               | 说明                | 触发时机        |
| -------------------- | ------------------- | --------------- |
| `ecp.challenge`      | 认证挑战            | 连接建立时      |
| `ecp.welcome`        | 连接欢迎 + 初始策略 | register 验证后 |
| `ecp.policy.push`    | 策略推送            | 策略变更时      |
| `ecp.config.push`    | 配置补丁            | 管理员操作时    |
| `ecp.version.notify` | 版本通知            | 新版本发布时    |
| `ecp.emergency`      | 紧急操作            | 管理员触发时    |

### 连接生命周期

```
Gateway 启动
  → WS 连接 ECP (wss://ecp:19000/ws/fleet)
  ← 接收 ecp.challenge { nonce }
  → 发送 ecp.register { gateway_id, version, ..., auth_token: HMAC(nonce, secret) }
  ← 接收 ecp.welcome { policy_version, policies[], config_overrides[] }
  → 每 30s 发送 ecp.heartbeat { connected_clients, active_sessions, policy_version }
  ← 随时接收 policy/config/version/emergency 推送
  → 每次推送回复 ecp.ack { request_id, ok }
```

### 帧定义 (Rust)

```rust
#[derive(Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum GatewayFrame {
    #[serde(rename = "ecp.register")]
    Register {
        gateway_id: String,
        version: String,
        hostname: String,
        port: u16,
        config_hash: String,
        capabilities: Vec<String>,
        connected_clients: u32,
        active_agent_sessions: u32,
        started_at: u64,
        auth_token: String,
    },
    #[serde(rename = "ecp.heartbeat")]
    Heartbeat {
        connected_clients: u32,
        active_agent_sessions: u32,
        policy_version: u64,
    },
    #[serde(rename = "ecp.ack")]
    Ack {
        request_id: String,
        ok: bool,
        error: Option<String>,
    },
    #[serde(rename = "ecp.audit")]
    Audit {
        actor: String,
        action: String,
        target: String,
        details: serde_json::Value,
        outcome: String,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum EcpFrame {
    #[serde(rename = "ecp.challenge")]
    Challenge { nonce: String },

    #[serde(rename = "ecp.welcome")]
    Welcome {
        policy_version: u64,
        policies: Vec<PolicyRule>,
        config_overrides: Vec<ConfigOverride>,
    },
    #[serde(rename = "ecp.policy.push")]
    PolicyPush {
        request_id: String,
        policy_version: u64,
        mode: PushMode,
        policies: Vec<PolicyRule>,
    },
    #[serde(rename = "ecp.config.push")]
    ConfigPush {
        request_id: String,
        overrides: Vec<ConfigOverride>,
    },
    #[serde(rename = "ecp.version.notify")]
    VersionNotify {
        request_id: String,
        version: String,
        download_url: Option<String>,
        changelog: Option<String>,
        severity: String,
    },
    #[serde(rename = "ecp.emergency")]
    Emergency {
        request_id: String,
        action: EmergencyAction,
        target: String,
        reason: String,
    },
}
```

---

## 数据模型

### gateways

| 字段                  | 类型           | 说明                             |
| --------------------- | -------------- | -------------------------------- |
| id                    | VARCHAR(64) PK | 稳定 Gateway UUID                |
| hostname              | VARCHAR(255)   | 主机名                           |
| port                  | INT            | 端口                             |
| version               | VARCHAR(32)    | 软件版本                         |
| config_hash           | VARCHAR(128)   | 当前配置 SHA256                  |
| capabilities          | JSON           | 能力列表                         |
| connected_clients     | INT            | 已连接客户端数                   |
| active_agent_sessions | INT            | 活跃 Agent 会话数                |
| policy_version        | BIGINT         | 已应用的策略版本                 |
| status                | VARCHAR(16)    | connected / stale / disconnected |
| last_heartbeat_at     | BIGINT         | 最后心跳时间 (unix ms)           |
| created_at            | BIGINT         | 首次注册时间                     |

### policies

| 字段              | 类型                | 说明                                         |
| ----------------- | ------------------- | -------------------------------------------- |
| id                | VARCHAR(64) PK      | UUID                                         |
| name              | VARCHAR(255) UNIQUE | 策略名称                                     |
| priority          | INT                 | 优先级 (越低越高)                            |
| effect            | VARCHAR(16)         | allow / deny / rate_limit                    |
| scope_type        | VARCHAR(32)         | tool / plugin / prompt / model / file_access |
| scope_target      | VARCHAR(255)        | glob 匹配模式                                |
| conditions        | JSON                | 条件: users, groups, gateways, timeWindow    |
| rate_limit_config | JSON NULL           | 限流配置                                     |
| enabled           | BOOLEAN             | 启用状态                                     |
| version           | INT                 | 策略版本 (每次编辑递增)                      |
| created_at        | BIGINT              | 创建时间                                     |
| updated_at        | BIGINT              | 更新时间                                     |

### config_overrides

| 字段           | 类型             | 说明                           |
| -------------- | ---------------- | ------------------------------ |
| id             | VARCHAR(64) PK   | UUID                           |
| target_gateway | VARCHAR(64) NULL | NULL=全部, 否则指定 gateway id |
| path           | VARCHAR(512)     | 配置路径 (e.g. "tools.deny")   |
| value          | JSON             | 值                             |
| priority       | VARCHAR(16)      | normal / override              |
| created_at     | BIGINT           | 创建时间                       |

### audit_log

| 字段       | 类型           | 说明              |
| ---------- | -------------- | ----------------- |
| id         | BIGINT AUTO PK | 自增              |
| ts         | BIGINT         | 时间戳 (unix ms)  |
| gateway_id | VARCHAR(64)    | 来源 Gateway      |
| actor      | VARCHAR(255)   | 操作者            |
| action     | VARCHAR(64)    | 动作类型          |
| target     | VARCHAR(255)   | 目标资源          |
| details    | JSON           | 详情              |
| outcome    | VARCHAR(16)    | success / failure |

---

## 策略引擎

### 规则结构

```rust
pub struct PolicyRule {
    pub id: String,
    pub name: String,
    pub priority: i32,
    pub effect: PolicyEffect,        // Allow | Deny | RateLimit
    pub scope_type: ScopeType,       // Tool | Plugin | Prompt | Model | FileAccess
    pub scope_target: String,        // glob: "web_*", "file_read", "*"
    pub conditions: PolicyConditions,
    pub rate_limit_config: Option<RateLimitConfig>,
    pub enabled: bool,
}

pub struct PolicyConditions {
    pub users: Option<Vec<String>>,
    pub groups: Option<Vec<String>>,
    pub gateways: Option<Vec<String>>,
    pub time_window: Option<TimeWindow>,
}

pub struct EvalContext {
    pub user_id: String,
    pub groups: Vec<String>,
    pub gateway_id: String,
    pub scope_type: ScopeType,
    pub scope_target: String,
    pub timestamp: u64,
}
```

### 评估算法

```
输入: Vec<PolicyRule>, EvalContext
输出: EvalResult { effect, matched_rule_id?, reason }

1. 过滤 enabled=true 的规则
2. 按 priority 升序排列
3. 逐条检查:
   a. scope_type 匹配?
   b. scope_target glob 匹配? (globset)
   c. conditions 满足? (user/group/gateway/time)
4. 第一条命中 → 返回其 effect (first-match-wins)
5. 无命中 → 默认 allow (可配置)
```

---

## Gateway Client SDK (TypeScript)

在 clawdbot 仓库中实现轻量 WS 客户端：

```
src/enterprise-control-plane/
├── client.ts              # WS 连接 + 重连 + 心跳
├── handler.ts             # 入站消息分发
├── enforcement.ts         # 策略注入到 hook 系统
└── cache.ts               # 离线策略缓存
```

### 策略执行 Hook 注册

通过现有 plugin hook 系统注册合成 Hook (`__ecp_policy__`, priority=0):

| Hook 点               | 策略 Scope | 执行动作             |
| --------------------- | ---------- | -------------------- |
| `before_tool_call`    | `tool`     | 阻止被拒绝的工具调用 |
| `before_agent_start`  | `model`    | 阻止/覆盖模型选择    |
| `before_prompt_build` | `prompt`   | 阻止敏感 prompt 模式 |
| `before_install`      | `plugin`   | 阻止插件激活         |

### 离线降级

**permissive 模式 (默认)**：保持最后已知策略继续执行，审计事件本地缓冲重连后刷回。

**restrictive 模式**：缓存策略超过阈值 (5min) 后新工具调用默认拒绝。

---

## Admin HTTP API

```
Base: http://ecp:19001/api/v1
Auth: Bearer JWT

GET    /health                       - 健康检查（无认证）

# 舰队
GET    /gateways                     - 列出所有 Gateway 实例
GET    /gateways/:id                 - 详情 + 实时状态

# 策略
GET    /policies                     - 策略列表
POST   /policies                     - 创建策略
PUT    /policies/:id                 - 更新策略
DELETE /policies/:id                 - 删除策略
POST   /policies/evaluate            - 干跑评估 (测试用)
POST   /policies/push                - 强制推送到全部 Gateway

# 配置覆盖
GET    /config-overrides             - 列出配置覆盖
POST   /config-overrides             - 创建配置覆盖
DELETE /config-overrides/:id         - 撤销覆盖
POST   /config-overrides/push        - 推送到 Gateway

# 版本管理
POST   /versions                     - 发布新版本通知
POST   /versions/:id/push            - 推送版本通知

# 紧急控制
POST   /emergency/kill-tool          - 全局禁用工具
POST   /emergency/kill-plugin        - 全局禁用插件
POST   /emergency/disconnect-user    - 强制断开用户
POST   /emergency/pause-sessions     - 暂停所有 Agent 会话

# 审计
GET    /audit                        - 审计日志查询
```

---

## 部署

### Docker（多阶段构建）

```dockerfile
FROM rust:1.79-slim AS builder
WORKDIR /app
COPY . .
RUN cargo build --release --features postgres --bin ecp-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/ecp-server /usr/local/bin/
COPY config/ /etc/ecp/
EXPOSE 19000 19001
CMD ["ecp-server", "--config", "/etc/ecp/production.toml"]
```

### 运行时特性

- 最终镜像 ~30MB
- 启动时间 <100ms
- 内存占用 ~10-30MB
- 单二进制，零运行时依赖

### 配置

```toml
[server]
fleet_port = 19000
admin_port = 19001
admin_bind = "0.0.0.0"

[store]
backend = "postgres"  # postgres | mysql
url = "${DATABASE_URL}"
max_connections = 20

[auth]
jwt_secret = "${ECP_JWT_SECRET}"
gateway_shared_secret = "${ECP_GATEWAY_SECRET}"

[fleet]
heartbeat_interval_ms = 30000
stale_threshold_ms = 90000
disconnect_threshold_ms = 300000

[policy]
default_effect = "allow"
```

---

## 实现阶段

| Phase | 内容                                | 预期产出                                  |
| ----- | ----------------------------------- | ----------------------------------------- |
| 1     | 项目骨架 + 协议 + 存储 + Fleet WS   | 注册/心跳/welcome 流程跑通                |
| 2     | Policy Engine + enforcement hook    | 策略评估 + 工具阻止生效                   |
| 3     | Admin API + Config Push + Emergency | 管理员可通过 API 管理策略和配置           |
| 4     | Audit + 监控 + 生产加固             | 审计日志、Prometheus metrics、Docker 发布 |

---

## 风险与约束

| 风险                   | 缓解措施                                                |
| ---------------------- | ------------------------------------------------------- |
| ECP 单点故障           | permissive 降级 + 本地策略缓存                          |
| 策略推送延迟           | WebSocket 长连接 + 心跳确认策略版本                     |
| 配置冲突 (ECP vs 本地) | priority 字段区分 override/normal                       |
| 向后兼容               | controlPlaneUrl 为可选配置，不配置时完全不加载 ECP 模块 |
| 数据库选型差异         | sea-query 构建器 + sqlx feature flag 隔离方言           |
| Gateway SDK 维护成本   | 协议简单稳定，SDK 轻量 (<500 LOC)                       |
