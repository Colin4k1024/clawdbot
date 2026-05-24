export type PolicyEffect = "allow" | "deny" | "rate_limit";
export type ScopeType = "tool" | "plugin" | "prompt" | "model" | "file_access";

export type PolicyConditions = {
  time_ranges?: Array<{ start: string; end: string }>;
  ip_ranges?: string[];
  user_roles?: string[];
  custom?: Record<string, unknown>;
};

export type RateLimitConfig = {
  max_requests: number;
  window_seconds: number;
  burst_size?: number;
};

export type PolicyRule = {
  id: string;
  name: string;
  priority: number;
  effect: PolicyEffect;
  scope_type: ScopeType;
  scope_target: string;
  conditions: PolicyConditions;
  rate_limit_config?: RateLimitConfig;
  enabled: boolean;
};

export type ConfigOverride = {
  id: string;
  target_gateway?: string;
  path: string;
  value: unknown;
  priority: "normal" | "override";
  created_at: number;
};

export type PushMode = "replace" | "patch";

export type EmergencyAction = "kill_tool" | "kill_plugin" | "disconnect_user" | "pause_sessions";

// ECP → Gateway frames
export type EcpChallenge = { type: "ecp.challenge"; nonce: string };
export type EcpWelcome = {
  type: "ecp.welcome";
  policy_version: number;
  policies: PolicyRule[];
  config_overrides: ConfigOverride[];
};
export type EcpPolicyPush = {
  type: "ecp.policy.push";
  request_id: string;
  policy_version: number;
  mode: PushMode;
  policies: PolicyRule[];
};
export type EcpConfigPush = {
  type: "ecp.config.push";
  request_id: string;
  overrides: ConfigOverride[];
};
export type EcpEmergency = {
  type: "ecp.emergency";
  request_id: string;
  action: EmergencyAction;
  target: string;
  reason: string;
};

export type EcpInboundFrame =
  | EcpChallenge
  | EcpWelcome
  | EcpPolicyPush
  | EcpConfigPush
  | EcpEmergency;

// Gateway → ECP frames
export type GatewayRegister = {
  type: "ecp.register";
  gateway_id: string;
  version: string;
  hostname: string;
  port: number;
  config_hash: string;
  capabilities: string[];
  connected_clients: number;
  active_agent_sessions: number;
  started_at: number;
  auth_token: string;
};

export type GatewayHeartbeat = {
  type: "ecp.heartbeat";
  connected_clients: number;
  active_agent_sessions: number;
  policy_version: number;
};

export type GatewayAck = {
  type: "ecp.ack";
  request_id: string;
  ok: boolean;
  error?: string;
};

export type GatewayAudit = {
  type: "ecp.audit";
  actor: string;
  action: string;
  target: string;
  details: unknown;
  outcome: "success" | "failure";
};

export type GatewayOutboundFrame = GatewayRegister | GatewayHeartbeat | GatewayAck | GatewayAudit;

export type EcpClientConfig = {
  url: string;
  gatewayId: string;
  gatewaySecret: string;
  version: string;
  hostname: string;
  port: number;
  configHash: string;
  capabilities: string[];
  heartbeatIntervalMs?: number;
  reconnectIntervalMs?: number;
  maxReconnectAttempts?: number;
};

export type EcpClientState = "disconnected" | "connecting" | "authenticating" | "connected";
