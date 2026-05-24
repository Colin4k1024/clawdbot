export { EcpClient } from "./client.js";
export { EcpHandler } from "./handler.js";
export { PolicyEnforcer } from "./enforcement.js";
export {
  startEcpIntegration,
  stopEcpIntegration,
  checkEcpPolicy,
  isEcpConnected,
  updateEcpStats,
  sendEcpAudit,
} from "./gateway-integration.js";
export type {
  EcpClientConfig,
  EcpClientState,
  PolicyRule,
  PolicyEffect,
  ConfigOverride,
  EcpInboundFrame,
  GatewayOutboundFrame,
  EmergencyAction,
} from "./types.js";
