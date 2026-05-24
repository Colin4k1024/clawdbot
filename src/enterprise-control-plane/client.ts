import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import type {
  EcpClientConfig,
  EcpClientState,
  EcpInboundFrame,
  GatewayOutboundFrame,
  GatewayHeartbeat,
  GatewayRegister,
  GatewayAudit,
  GatewayAck,
} from "./types.js";

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_RECONNECT_MS = 5_000;
const DEFAULT_MAX_RECONNECT = 10;

export class EcpClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private state: EcpClientState = "disconnected";
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private connectedClients = 0;
  private activeAgentSessions = 0;
  private policyVersion = 0;
  private startedAt = Date.now();

  constructor(private readonly config: EcpClientConfig) {
    super();
  }

  get currentState(): EcpClientState {
    return this.state;
  }

  get currentPolicyVersion(): number {
    return this.policyVersion;
  }

  connect(): void {
    if (this.state !== "disconnected") return;
    this.state = "connecting";
    this.emit("state", this.state);

    try {
      this.ws = new WebSocket(this.config.url);
    } catch (err) {
      this.handleDisconnect(err as Error);
      return;
    }

    this.ws.on("open", () => {
      this.state = "authenticating";
      this.emit("state", this.state);
    });

    this.ws.on("message", (data) => {
      try {
        const frame = JSON.parse(data.toString()) as EcpInboundFrame;
        this.handleFrame(frame);
      } catch {
        // ignore malformed frames
      }
    });

    this.ws.on("close", () => this.handleDisconnect());
    this.ws.on("error", (err) => this.handleDisconnect(err));
  }

  disconnect(): void {
    this.stopHeartbeat();
    this.stopReconnect();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.state = "disconnected";
    this.emit("state", this.state);
  }

  updateStats(connectedClients: number, activeAgentSessions: number): void {
    this.connectedClients = connectedClients;
    this.activeAgentSessions = activeAgentSessions;
  }

  sendAudit(
    actor: string,
    action: string,
    target: string,
    details: unknown,
    outcome: "success" | "failure",
  ): void {
    const frame: GatewayAudit = {
      type: "ecp.audit",
      actor,
      action,
      target,
      details,
      outcome,
    };
    this.send(frame);
  }

  sendAck(requestId: string, ok: boolean, error?: string): void {
    const frame: GatewayAck = { type: "ecp.ack", request_id: requestId, ok, error };
    this.send(frame);
  }

  private handleFrame(frame: EcpInboundFrame): void {
    switch (frame.type) {
      case "ecp.challenge":
        this.handleChallenge(frame.nonce);
        break;
      case "ecp.welcome":
        this.state = "connected";
        this.reconnectAttempts = 0;
        this.policyVersion = frame.policy_version;
        this.startHeartbeat();
        this.emit("state", this.state);
        this.emit("welcome", frame);
        break;
      case "ecp.policy.push":
        if (frame.policy_version > this.policyVersion) {
          this.policyVersion = frame.policy_version;
          this.sendAck(frame.request_id, true);
        }
        this.emit("policy_push", frame);
        break;
      case "ecp.config.push":
        this.sendAck(frame.request_id, true);
        this.emit("config_push", frame);
        break;
      case "ecp.emergency":
        this.sendAck(frame.request_id, true);
        this.emit("emergency", frame);
        break;
    }
  }

  private handleChallenge(nonce: string): void {
    const authToken = createHmac("sha256", this.config.gatewaySecret).update(nonce).digest("hex");

    const register: GatewayRegister = {
      type: "ecp.register",
      gateway_id: this.config.gatewayId,
      version: this.config.version,
      hostname: this.config.hostname,
      port: this.config.port,
      config_hash: this.config.configHash,
      capabilities: this.config.capabilities,
      connected_clients: this.connectedClients,
      active_agent_sessions: this.activeAgentSessions,
      started_at: this.startedAt,
      auth_token: authToken,
    };
    this.send(register);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = this.config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    this.heartbeatTimer = setInterval(() => {
      const hb: GatewayHeartbeat = {
        type: "ecp.heartbeat",
        connected_clients: this.connectedClients,
        active_agent_sessions: this.activeAgentSessions,
        policy_version: this.policyVersion,
      };
      this.send(hb);
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private stopReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private handleDisconnect(err?: Error): void {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws = null;
    }
    this.state = "disconnected";
    this.emit("state", this.state);
    if (err) this.emit("error", err);

    const maxAttempts = this.config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT;
    if (this.reconnectAttempts < maxAttempts) {
      this.reconnectAttempts++;
      const baseDelay = this.config.reconnectIntervalMs ?? DEFAULT_RECONNECT_MS;
      const backoff = Math.min(baseDelay * Math.pow(1.5, this.reconnectAttempts - 1), 60_000);
      const jitter = Math.random() * backoff * 0.3;
      this.reconnectTimer = setTimeout(() => this.connect(), backoff + jitter);
    } else {
      this.emit("max_reconnect");
    }
  }

  private send(frame: GatewayOutboundFrame): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }
}
