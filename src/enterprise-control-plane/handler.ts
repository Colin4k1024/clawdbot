import type { EcpClient } from "./client.js";
import { PolicyEnforcer } from "./enforcement.js";
import type {
  EcpWelcome,
  EcpPolicyPush,
  EcpConfigPush,
  EcpEmergency,
  ConfigOverride,
  PolicyRule,
} from "./types.js";

export type EcpHandlerCallbacks = {
  onPoliciesUpdated?: (policies: PolicyRule[]) => void;
  onConfigOverrides?: (overrides: ConfigOverride[]) => void;
  onEmergency?: (action: string, target: string, reason: string) => void;
};

export class EcpHandler {
  readonly enforcer = new PolicyEnforcer();
  private configOverrides: ConfigOverride[] = [];

  constructor(
    private readonly client: EcpClient,
    private readonly callbacks?: EcpHandlerCallbacks,
  ) {
    client.on("welcome", (frame: EcpWelcome) => this.handleWelcome(frame));
    client.on("policy_push", (frame: EcpPolicyPush) => this.handlePolicyPush(frame));
    client.on("config_push", (frame: EcpConfigPush) => this.handleConfigPush(frame));
    client.on("emergency", (frame: EcpEmergency) => this.handleEmergency(frame));
  }

  getConfigOverrides(): ConfigOverride[] {
    return this.configOverrides;
  }

  private handleWelcome(frame: EcpWelcome): void {
    this.enforcer.updatePolicies(frame.policies);
    this.configOverrides = frame.config_overrides;
    this.callbacks?.onPoliciesUpdated?.(frame.policies);
    this.callbacks?.onConfigOverrides?.(frame.config_overrides);
  }

  private handlePolicyPush(frame: EcpPolicyPush): void {
    if (frame.mode === "replace") {
      this.enforcer.updatePolicies(frame.policies);
    }
    this.callbacks?.onPoliciesUpdated?.(frame.policies);
  }

  private handleConfigPush(frame: EcpConfigPush): void {
    this.configOverrides = frame.overrides;
    this.callbacks?.onConfigOverrides?.(frame.overrides);
  }

  private handleEmergency(frame: EcpEmergency): void {
    this.callbacks?.onEmergency?.(frame.action, frame.target, frame.reason);
  }
}
