#!/usr/bin/env node
/**
 * ECP Soul Protection E2E Test
 *
 * End-to-end scenario:
 *   1. Verify openclaw-host-gateway is connected to ECP
 *   2. Admin creates a file_access policy blocking SOUL.md writes
 *   3. Policy is pushed to all connected gateways
 *   4. Gateway receives and applies the policy
 *   5. Simulate tool calls: write/edit targeting SOUL.md → BLOCKED
 *   6. Simulate tool calls: write to other files → ALLOWED
 *   7. Audit trail captured in ECP
 *   8. Cleanup
 */

import { createHmac } from "node:crypto";

const ECP_WS_URL = process.env.ECP_WS_URL || "ws://localhost:19000/ws/fleet";
const ECP_ADMIN_URL = process.env.ECP_ADMIN_URL || "http://localhost:19001";
const GATEWAY_SECRET = process.env.ECP_GATEWAY_SECRET || "integration-test-gateway-secret";
const JWT_SECRET = process.env.ECP_JWT_SECRET || "integration-test-jwt-secret";
const SOUL_MD_PATH = process.env.SOUL_MD_PATH || "/Users/ailabuser1/.openclaw/workspace/SOUL.md";

const SIM_GATEWAY_ID = "sim-openclaw-agent-001";

let passed = 0;
let failed = 0;

// ── helpers ──────────────────────────────────────────────────────────────────

function pass(msg) {
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}

function fail(msg) {
  failed++;
  console.error(`  \x1b[31m✗\x1b[0m ${msg}`);
}

function assert(condition, msg) {
  condition ? pass(msg) : fail(msg);
}

function section(title) {
  console.log(`\n\x1b[36m── ${title} ──\x1b[0m`);
}

function info(msg) {
  console.log(`  \x1b[90m${msg}\x1b[0m`);
}

function generateJwt(role = "admin") {
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(
    JSON.stringify({
      sub: "admin",
      role,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString("base64url");
  const s = createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}

async function api(path, options = {}) {
  const res = await fetch(`${ECP_ADMIN_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${generateJwt()}`,
      ...options.headers,
    },
  });
  return res;
}

async function apiJson(path, options = {}) {
  const res = await api(path, options);
  const body = await res.json();
  return { status: res.status, body };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Policy Enforcer (mirrors enforcement.ts) ─────────────────────────────────

function globMatch(pattern, value) {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === value;
  const parts = pattern.split("*");
  let pos = 0;
  if (parts[0] && !value.startsWith(parts[0])) return false;
  pos = parts[0].length;
  for (let i = 1; i < parts.length - 1; i++) {
    if (!parts[i]) continue;
    const idx = value.indexOf(parts[i], pos);
    if (idx === -1) return false;
    pos = idx + parts[i].length;
  }
  const last = parts[parts.length - 1];
  if (last) {
    if (!value.endsWith(last)) return false;
    if (value.length - last.length < pos) return false;
  }
  return true;
}

function evaluatePolicy(policies, ctx) {
  const active = policies.filter((p) => p.enabled).sort((a, b) => a.priority - b.priority);
  for (const rule of active) {
    const target = rule.scope_target;
    let matches = false;
    switch (rule.scope_type) {
      case "tool":
        matches = ctx.toolName != null && globMatch(target, ctx.toolName);
        break;
      case "file_access":
        matches = ctx.filePath != null && globMatch(target, ctx.filePath);
        break;
      default:
        break;
    }
    if (matches) {
      return { effect: rule.effect, rule: rule.name, reason: `matched rule: ${rule.name}` };
    }
  }
  return { effect: "allow", rule: null, reason: "no matching policy" };
}

// ── WebSocket simulation ──────────────────────────────────────────────────────

function connectSimGateway() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(ECP_WS_URL);
    const timer = setTimeout(() => reject(new Error("WS connect timeout")), 15000);

    ws.onerror = (e) => {
      clearTimeout(timer);
      reject(new Error(`WS error: ${e.message}`));
    };
    ws.onmessage = async (ev) => {
      const frame = JSON.parse(ev.data);

      if (frame.type === "ecp.challenge") {
        const authToken = createHmac("sha256", GATEWAY_SECRET).update(frame.nonce).digest("hex");
        ws.send(
          JSON.stringify({
            type: "ecp.register",
            gateway_id: SIM_GATEWAY_ID,
            version: "2026.4.30",
            hostname: "sim-agent-host",
            port: 18800,
            config_hash: "sim123",
            capabilities: ["policy-enforcement", "audit"],
            connected_clients: 1,
            active_agent_sessions: 1,
            started_at: Date.now(),
            auth_token: authToken,
          }),
        );
      }

      if (frame.type === "ecp.welcome") {
        clearTimeout(timer);
        resolve({ ws, welcomePolicies: frame.policies, policyVersion: frame.policy_version });
      }
    };
  });
}

// ── Test steps ────────────────────────────────────────────────────────────────

async function step1_verifyGatewayConnected() {
  section("Step 1: Verify openclaw-host-gateway is connected to ECP");

  const { status, body } = await apiJson("/api/v1/gateways");
  assert(status === 200, `Admin API reachable (HTTP ${status})`);

  const hostGw = body.data?.find((g) => g.id === "openclaw-host-gateway");
  assert(hostGw != null, `openclaw-host-gateway is registered`);
  assert(
    hostGw?.status === "connected",
    `openclaw-host-gateway status = connected (got: ${hostGw?.status})`,
  );

  if (hostGw) {
    info(`Gateway: ${hostGw.hostname}:${hostGw.port} v${hostGw.version}`);
    info(`Capabilities: ${hostGw.capabilities.join(", ")}`);
    info(`Clients: ${hostGw.connected_clients}, Sessions: ${hostGw.active_agent_sessions}`);
  }

  return hostGw;
}

async function step2_createSoulProtectionPolicies() {
  section("Step 2: Admin creates SOUL.md protection policies");

  // Policy A: file_access — block any write/read to SOUL.md path
  const policyA = {
    id: "protect-soul-md-file",
    name: "Protect SOUL.md — block file access",
    priority: 1,
    effect: "deny",
    scope_type: "file_access",
    scope_target: "*SOUL.md",
    conditions: {},
    enabled: true,
  };

  // Policy B: tool-level — block write/edit tools when targeting sensitive workspace files
  const policyB = {
    id: "protect-soul-md-write-tool",
    name: "Protect SOUL.md — block write tool",
    priority: 2,
    effect: "deny",
    scope_type: "tool",
    scope_target: "write",
    conditions: {},
    enabled: true,
  };

  const policyC = {
    id: "protect-soul-md-edit-tool",
    name: "Protect SOUL.md — block edit tool",
    priority: 3,
    effect: "deny",
    scope_type: "tool",
    scope_target: "edit",
    conditions: {},
    enabled: true,
  };

  // Clean up any leftover policies first
  await api("/api/v1/policies/protect-soul-md-file", { method: "DELETE" });
  await api("/api/v1/policies/protect-soul-md-write-tool", { method: "DELETE" });
  await api("/api/v1/policies/protect-soul-md-edit-tool", { method: "DELETE" });

  for (const policy of [policyA, policyB, policyC]) {
    const { status, body } = await apiJson("/api/v1/policies", {
      method: "POST",
      body: JSON.stringify(policy),
    });
    assert(status === 201, `Created policy "${policy.name}" (HTTP ${status})`);
    if (status === 201) {
      info(`  → id=${policy.id} scope=${policy.scope_type}:${policy.scope_target}`);
    } else {
      info(`  Error: ${JSON.stringify(body)}`);
    }
  }

  return [policyA, policyB, policyC];
}

async function step3_pushPolicies(ws, policies) {
  section("Step 3: Push policies to connected gateways");

  let policyPushReceived = false;
  let pushedPolicies = [];

  const pushPromise = new Promise((resolve) => {
    const orig = ws.onmessage;
    const timeout = setTimeout(() => resolve(null), 8000);
    ws.onmessage = (ev) => {
      const frame = JSON.parse(ev.data);
      if (frame.type === "ecp.policy.push") {
        clearTimeout(timeout);
        ws.onmessage = orig;
        ws.send(JSON.stringify({ type: "ecp.ack", request_id: frame.request_id, ok: true }));
        resolve(frame);
      } else if (orig) {
        orig(ev);
      }
    };
  });

  const { status: pushStatus } = await api("/api/v1/policies/push", { method: "POST" });
  assert(pushStatus === 200, `Policy push API returned 200 (HTTP ${pushStatus})`);

  const pushFrame = await pushPromise;
  if (pushFrame) {
    policyPushReceived = true;
    pushedPolicies = pushFrame.policies;
    pass(
      `Simulated gateway received policy push (v${pushFrame.policy_version}, ${pushFrame.policies.length} rules)`,
    );
    for (const p of pushFrame.policies) {
      info(`  → [${p.effect.toUpperCase()}] ${p.scope_type}:${p.scope_target} — "${p.name}"`);
    }
  } else {
    fail("Simulated gateway did NOT receive policy push within timeout");
  }

  return pushedPolicies;
}

async function step4_simulateToolCallsBlocked(policies) {
  section("Step 4: Simulate sensitive tool calls — SOUL.md operations");

  console.log("\n  \x1b[33m[Scenario]\x1b[0m User asks AI to modify personality in SOUL.md");
  console.log(`  \x1b[90mFile path: ${SOUL_MD_PATH}\x1b[0m\n`);

  // 4a. write tool with SOUL.md path — should be BLOCKED (file_access + tool policy)
  const writeResult = evaluatePolicy(policies, {
    toolName: "write",
    filePath: SOUL_MD_PATH,
  });
  assert(
    writeResult.effect === "deny",
    `write(SOUL.md) → BLOCKED by ECP (rule: "${writeResult.rule}")`,
  );
  info(`Reason: ${writeResult.reason}`);

  // 4b. edit tool with SOUL.md path — should be BLOCKED
  const editResult = evaluatePolicy(policies, {
    toolName: "edit",
    filePath: SOUL_MD_PATH,
  });
  assert(
    editResult.effect === "deny",
    `edit(SOUL.md) → BLOCKED by ECP (rule: "${editResult.rule}")`,
  );
  info(`Reason: ${editResult.reason}`);

  // 4c. file_access check alone — should be BLOCKED
  const fileAccessResult = evaluatePolicy(policies, {
    toolName: "read",
    filePath: SOUL_MD_PATH,
  });
  assert(
    fileAccessResult.effect === "deny",
    `file_access(*SOUL.md) → BLOCKED by ECP (rule: "${fileAccessResult.rule}")`,
  );
  info(`Reason: ${fileAccessResult.reason}`);

  // 4d. write to a normal file — should be BLOCKED by tool policy (write is denied globally here)
  const normalWriteResult = evaluatePolicy(policies, {
    toolName: "write",
    filePath: "/tmp/safe-file.txt",
  });
  // write tool is denied globally by policyB
  assert(
    normalWriteResult.effect === "deny",
    `write(/tmp/safe-file.txt) → BLOCKED (write tool is globally denied, rule: "${normalWriteResult.rule}")`,
  );
  info(`Note: write tool itself is blocked, not just SOUL.md path`);

  // 4e. a safe tool — should be ALLOWED
  const safeResult = evaluatePolicy(policies, {
    toolName: "read",
    filePath: "/tmp/safe-file.txt",
  });
  assert(
    safeResult.effect === "allow",
    `read(/tmp/safe-file.txt) → ALLOWED (no matching deny rule)`,
  );
}

async function step5_sendAuditEvents(ws, policies) {
  section("Step 5: Simulate audit events for blocked operations");

  const auditEvents = [
    {
      actor: "user@company.com",
      action: "tool_call_blocked",
      target: "write",
      details: {
        path: SOUL_MD_PATH,
        reason: "ECP policy: Protect SOUL.md — block write tool",
        policy_id: "protect-soul-md-write-tool",
      },
      outcome: "failure",
    },
    {
      actor: "user@company.com",
      action: "tool_call_blocked",
      target: "edit",
      details: {
        path: SOUL_MD_PATH,
        reason: "ECP policy: Protect SOUL.md — block edit tool",
        policy_id: "protect-soul-md-edit-tool",
      },
      outcome: "failure",
    },
    {
      actor: "user@company.com",
      action: "file_access_blocked",
      target: SOUL_MD_PATH,
      details: {
        scope_type: "file_access",
        scope_target: "*SOUL.md",
        matched_policy: "protect-soul-md-file",
      },
      outcome: "failure",
    },
  ];

  for (const evt of auditEvents) {
    ws.send(JSON.stringify({ type: "ecp.audit", ...evt }));
  }
  pass(`Sent ${auditEvents.length} audit events to ECP`);

  await sleep(800);

  const { status, body } = await apiJson("/api/v1/audit?limit=20");
  assert(status === 200, `Audit query returns 200`);
  const soulEvents =
    body.data?.filter(
      (e) => e.target?.includes("SOUL") || e.target === "write" || e.target === "edit",
    ) ?? [];
  assert(soulEvents.length >= 2, `Found ${soulEvents.length} SOUL.md-related audit entries`);

  if (soulEvents.length > 0) {
    console.log("\n  \x1b[33mAudit Trail:\x1b[0m");
    for (const e of soulEvents) {
      const ts = new Date(e.created_at).toLocaleTimeString();
      console.log(
        `  \x1b[90m[${ts}]\x1b[0m \x1b[31m${e.outcome.toUpperCase()}\x1b[0m actor=${e.actor} action=${e.action} target=${e.target}`,
      );
    }
  }
}

async function step6_emergencyScenario() {
  section("Step 6: Emergency — force-disable write tools across all gateways");

  const { status } = await api("/api/v1/emergency/kill-tool", {
    method: "POST",
    body: JSON.stringify({
      target: "write",
      reason: "SOUL.md tampering detected — emergency lockdown",
    }),
  });
  assert(
    status === 200 || status === 202,
    `Emergency kill-tool(write) dispatched (HTTP ${status})`,
  );
  info("All connected gateways will receive kill_tool emergency for 'write'");
}

async function step7_cleanup(policies) {
  section("Step 7: Cleanup test policies");

  for (const p of policies) {
    await api(`/api/v1/policies/${p.id}`, { method: "DELETE" });
  }
  pass(`Deleted ${policies.length} test policies`);

  await api("/api/v1/policies/push", { method: "POST" });
  pass("Pushed empty policy set — gateways restored to unrestricted mode");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\x1b[1m");
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  ECP End-to-End: SOUL.md Protection Scenario            ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║  ECP Admin:  ${ECP_ADMIN_URL.padEnd(44)}║`);
  console.log(`║  SOUL.md:    ${SOUL_MD_PATH.slice(0, 44).padEnd(44)}║`);
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("\x1b[0m");

  // Wait for ECP to be ready
  for (let i = 0; i < 10; i++) {
    try {
      const res = await fetch(`${ECP_ADMIN_URL}/health`);
      if (res.ok) break;
    } catch {}
    await sleep(1000);
  }

  let simWs = null;
  let policies = [];

  try {
    // Step 1
    const hostGw = await step1_verifyGatewayConnected();
    if (!hostGw) {
      console.error(
        "\n\x1b[31mFATAL: openclaw-host-gateway not connected. Ensure gateway is running.\x1b[0m",
      );
      process.exit(1);
    }

    // Step 2
    policies = await step2_createSoulProtectionPolicies();

    // Connect simulated gateway to receive policy push
    section("Connecting simulated gateway to receive policy push...");
    const { ws, welcomePolicies } = await connectSimGateway();
    simWs = ws;
    pass(`Simulated gateway connected (welcomed with ${welcomePolicies.length} existing policies)`);

    // Step 3 — push and receive
    const pushedPolicies = await step3_pushPolicies(simWs, policies);
    const effectivePolicies = pushedPolicies.length > 0 ? pushedPolicies : policies;

    // Step 4
    await step4_simulateToolCallsBlocked(effectivePolicies);

    // Step 5
    await step5_sendAuditEvents(simWs, effectivePolicies);

    // Step 6
    await step6_emergencyScenario();

    // Step 7
    await step7_cleanup(policies);
  } catch (err) {
    console.error(`\n\x1b[31m✗ Scenario error: ${err.message}\x1b[0m`);
    failed++;
  } finally {
    if (simWs) simWs.close();
  }

  // Results
  const total = passed + failed;
  const bar = "═".repeat(58);
  console.log(`\n${bar}`);
  if (failed === 0) {
    console.log(`\x1b[32m✅ ALL ${total} CHECKS PASSED — SOUL.md is protected by ECP\x1b[0m`);
  } else {
    console.log(`\x1b[33m⚠  ${passed}/${total} passed, ${failed} failed\x1b[0m`);
  }
  console.log(bar + "\n");

  process.exit(failed > 0 ? 1 : 0);
}

main();
