import { createHash } from "node:crypto";
import { hostname } from "node:os";
import type { GatewayEcpConfig } from "../config/types.gateway.js";
import { EcpClient } from "./client.js";
import type { EvalContext } from "./enforcement.js";
import { EcpHandler } from "./handler.js";
import type { EcpClientConfig, PolicyRule, ConfigOverride } from "./types.js";

type EcpPolicyResult = { blocked: true; reason: string } | { blocked: false };

let ecpClient: EcpClient | null = null;
let ecpHandler: EcpHandler | null = null;
let disconnectedMode: "permissive" | "restrictive" = "permissive";

export function isEcpConnected(): boolean {
  return ecpClient?.currentState === "connected";
}

export function checkEcpPolicy(ctx: EvalContext): EcpPolicyResult {
  if (!ecpHandler) return { blocked: false };

  if (!isEcpConnected()) {
    if (disconnectedMode === "restrictive") {
      return { blocked: true, reason: "ECP unreachable (restrictive mode)" };
    }
    return { blocked: false };
  }

  const result = ecpHandler.enforcer.evaluate(ctx);
  if (result.effect === "deny") {
    return { blocked: true, reason: result.reason ?? "denied by ECP policy" };
  }
  return { blocked: false };
}

export function startEcpIntegration(opts: {
  ecpConfig: GatewayEcpConfig;
  gatewayPort: number;
  gatewayVersion: string;
  configHash?: string;
  log?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  onPoliciesUpdated?: (policies: PolicyRule[]) => void;
  onConfigOverrides?: (overrides: ConfigOverride[]) => void;
  onEmergency?: (action: string, target: string, reason: string) => void;
}): void {
  const { ecpConfig, gatewayPort, gatewayVersion, log } = opts;

  const url = ecpConfig.url ?? process.env.OPENCLAW_ECP_URL;
  const gatewaySecretRaw = ecpConfig.gatewaySecret ?? process.env.OPENCLAW_ECP_GATEWAY_SECRET;

  if (!url || !gatewaySecretRaw) {
    log?.info("ECP integration disabled (missing url or secret)");
    return;
  }

  disconnectedMode = ecpConfig.disconnectedMode ?? "permissive";

  let secret: string;
  if (typeof gatewaySecretRaw === "string") {
    secret = gatewaySecretRaw;
  } else {
    const ref = gatewaySecretRaw;
    secret = ref.source === "env" ? (process.env[ref.id] ?? "") : "";
  }

  const clientConfig: EcpClientConfig = {
    url,
    gatewayId: ecpConfig.gatewayId ?? process.env.OPENCLAW_ECP_GATEWAY_ID ?? `gw-${hostname()}`,
    gatewaySecret: secret,
    version: gatewayVersion,
    hostname: hostname(),
    port: gatewayPort,
    configHash:
      opts.configHash ??
      createHash("sha256").update(JSON.stringify(ecpConfig)).digest("hex").slice(0, 16),
    capabilities: ["policy-enforcement", "config-override", "audit"],
    heartbeatIntervalMs: ecpConfig.heartbeatIntervalMs,
    reconnectIntervalMs: ecpConfig.reconnectIntervalMs,
    maxReconnectAttempts: ecpConfig.maxReconnectAttempts,
  };

  ecpClient = new EcpClient(clientConfig);
  ecpHandler = new EcpHandler(ecpClient, {
    onPoliciesUpdated: opts.onPoliciesUpdated,
    onConfigOverrides: opts.onConfigOverrides,
    onEmergency: opts.onEmergency,
  });

  ecpClient.on("state", (state: string) => {
    if (state === "connected") {
      log?.info("ECP connected — policies active");
    } else if (state === "disconnected") {
      log?.warn(`ECP disconnected (mode: ${disconnectedMode})`);
    }
  });

  ecpClient.on("error", (err: Error) => {
    log?.error(`ECP error: ${err.message}`);
  });

  ecpClient.on("max_reconnect", () => {
    log?.error("ECP max reconnection attempts reached");
  });

  ecpClient.connect();
  log?.info(`ECP client connecting to ${url}`);
}

export function stopEcpIntegration(): void {
  if (ecpClient) {
    ecpClient.disconnect();
    ecpClient = null;
    ecpHandler = null;
  }
}

export function updateEcpStats(connectedClients: number, activeAgentSessions: number): void {
  ecpClient?.updateStats(connectedClients, activeAgentSessions);
}

export function sendEcpAudit(
  actor: string,
  action: string,
  target: string,
  details: unknown,
  outcome: "success" | "failure",
): void {
  ecpClient?.sendAudit(actor, action, target, details, outcome);
}
