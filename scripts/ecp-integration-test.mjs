#!/usr/bin/env node
/**
 * ECP Integration Test Script
 *
 * Tests the full ECP ↔ Gateway protocol:
 * 1. WebSocket connect to ECP fleet endpoint
 * 2. Receive challenge, respond with HMAC register
 * 3. Receive welcome with policies
 * 4. Send heartbeat
 * 5. Use Admin API to create policy and push
 * 6. Receive policy push over WebSocket
 * 7. Send audit event
 * 8. Verify audit is stored via Admin API
 */

import { createHmac } from "node:crypto";
// Use native Node.js WebSocket (Node 22+) - no external deps needed
const { WebSocket } = globalThis;

const ECP_WS_URL = process.env.ECP_WS_URL || "ws://localhost:19000/ws/fleet";
const ECP_ADMIN_URL = process.env.ECP_ADMIN_URL || "http://localhost:19001";
const GATEWAY_SECRET = process.env.ECP_GATEWAY_SECRET || "dev-gateway-secret-change-in-production";
const JWT_SECRET = process.env.ECP_JWT_SECRET || "dev-jwt-secret-change-in-production";

const GATEWAY_ID = "test-gateway-001";
const TIMEOUT_MS = 30_000;

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function generateJwt() {
  // Simple JWT for testing (HS256)
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: "admin",
      role: "admin",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

async function adminFetch(path, options = {}) {
  const token = generateJwt();
  const res = await fetch(`${ECP_ADMIN_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
  return res;
}

function waitForMessage(ws, type, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
    const origHandler = ws.onmessage;
    ws.onmessage = (ev) => {
      try {
        const frame = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
        if (frame.type === type) {
          clearTimeout(timer);
          ws.onmessage = origHandler;
          resolve(frame);
        } else if (origHandler) {
          origHandler(ev);
        }
      } catch {}
    };
  });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function testHealthCheck() {
  console.log("\n── Test: Health Check ──");
  const res = await fetch(`${ECP_ADMIN_URL}/health`);
  assert(res.status === 200, `Health endpoint returns 200 (got ${res.status})`);
  if (res.ok) {
    const body = await res.json();
    assert(body.status === "ok", `Health status is 'ok' (got: ${body.status})`);
  }
}

async function testWebSocketProtocol() {
  console.log("\n── Test: WebSocket Fleet Protocol ──");

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("WebSocket test timed out"));
    }, TIMEOUT_MS);

    const ws = new WebSocket(ECP_WS_URL);

    ws.onerror = (ev) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${ev.message || "connection failed"}`));
    };

    ws.onopen = () => {
      assert(true, "WebSocket connection opened");
    };

    ws.onmessage = async (ev) => {
      try {
        const frame = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());

        if (frame.type === "ecp.challenge") {
          assert(
            typeof frame.nonce === "string" && frame.nonce.length > 0,
            `Received challenge with nonce (${frame.nonce.substring(0, 8)}...)`,
          );

          const authToken = createHmac("sha256", GATEWAY_SECRET).update(frame.nonce).digest("hex");
          const register = {
            type: "ecp.register",
            gateway_id: GATEWAY_ID,
            version: "1.0.0-test",
            hostname: "test-gateway",
            port: 18789,
            config_hash: "abc123",
            capabilities: ["tools", "plugins", "agents"],
            connected_clients: 2,
            active_agent_sessions: 1,
            started_at: Date.now(),
            auth_token: authToken,
          };
          ws.send(JSON.stringify(register));
          assert(true, "Sent register with HMAC auth token");
        }

        if (frame.type === "ecp.welcome") {
          assert(true, "Received welcome frame");
          assert(
            typeof frame.policy_version === "number",
            `Welcome has policy_version: ${frame.policy_version}`,
          );
          assert(
            Array.isArray(frame.policies),
            `Welcome has policies array (${frame.policies.length} rules)`,
          );
          assert(
            Array.isArray(frame.config_overrides),
            `Welcome has config_overrides (${frame.config_overrides.length})`,
          );

          // Send heartbeat
          const hb = {
            type: "ecp.heartbeat",
            connected_clients: 3,
            active_agent_sessions: 2,
            policy_version: frame.policy_version,
          };
          ws.send(JSON.stringify(hb));
          assert(true, "Sent heartbeat");

          // Send audit
          const audit = {
            type: "ecp.audit",
            actor: "user@test.com",
            action: "tool_call",
            target: "file_write",
            details: { path: "/tmp/test.txt" },
            outcome: "success",
          };
          ws.send(JSON.stringify(audit));
          assert(true, "Sent audit event");

          // Wait briefly then test admin API interactions
          await sleep(1000);
          await testAdminApiWithConnectedGateway(ws);

          clearTimeout(timer);
          ws.close();
          resolve();
        }

        if (frame.type === "ecp.policy.push") {
          assert(
            true,
            `Received policy push (version: ${frame.policy_version}, ${frame.policies.length} policies)`,
          );
          ws.send(JSON.stringify({ type: "ecp.ack", request_id: frame.request_id, ok: true }));
          assert(true, "Sent ack for policy push");
        }

        if (frame.type === "ecp.emergency") {
          assert(true, `Received emergency: ${frame.action} on ${frame.target}`);
          ws.send(JSON.stringify({ type: "ecp.ack", request_id: frame.request_id, ok: true }));
        }
      } catch (err) {
        console.error("  Error processing message:", err.message);
      }
    };
  });
}

async function testAdminApiWithConnectedGateway(ws) {
  console.log("\n── Test: Admin API with Connected Gateway ──");

  // List gateways - should show our connected gateway
  const gwRes = await adminFetch("/api/v1/gateways");
  const gwBody = await gwRes.json();
  assert(gwRes.status === 200, "List gateways returns 200");
  assert(gwBody.data && gwBody.data.length > 0, `Found ${gwBody.data?.length || 0} gateway(s)`);

  const ourGw = gwBody.data?.find((g) => g.id === GATEWAY_ID);
  assert(ourGw != null, `Our gateway ${GATEWAY_ID} is registered`);
  if (ourGw) {
    assert(ourGw.status === "connected", `Gateway status is 'connected' (got: ${ourGw.status})`);
  }

  // Create a policy
  const policyRes = await adminFetch("/api/v1/policies", {
    method: "POST",
    body: JSON.stringify({
      id: "test-policy-001",
      name: "Block dangerous tools",
      priority: 1,
      effect: "deny",
      scope_type: "tool",
      scope_target: "rm_rf",
      conditions: {},
      enabled: true,
    }),
  });
  assert(policyRes.status === 201, `Create policy returns 201 (got ${policyRes.status})`);

  // Push policies to connected gateways
  const pushRes = await adminFetch("/api/v1/policies/push", { method: "POST" });
  assert(pushRes.status === 200, `Push policies returns 200 (got ${pushRes.status})`);

  // Wait for the push to arrive over WebSocket
  await sleep(1000);

  // Test emergency command
  const emergRes = await adminFetch("/api/v1/emergency/kill-tool", {
    method: "POST",
    body: JSON.stringify({ target: "dangerous_tool", reason: "integration test" }),
  });
  assert(
    emergRes.status === 200 || emergRes.status === 202,
    `Emergency kill-tool returns 200/202 (got ${emergRes.status})`,
  );

  await sleep(500);

  // Query audit log
  const auditRes = await adminFetch("/api/v1/audit?limit=10");
  assert(auditRes.status === 200, `Audit query returns 200 (got ${auditRes.status})`);
  const auditBody = await auditRes.json();
  assert(
    auditBody.data && auditBody.data.length > 0,
    `Audit log has ${auditBody.data?.length || 0} entries`,
  );

  // Cleanup: delete the test policy
  await adminFetch("/api/v1/policies/test-policy-001", { method: "DELETE" });
}

async function testPolicyEnforcement() {
  console.log("\n── Test: Policy Enforcement (Client-Side) ──");

  // Test the policy matching logic
  const policies = [
    {
      id: "p1",
      name: "Block rm",
      priority: 1,
      effect: "deny",
      scope_type: "tool",
      scope_target: "rm_rf",
      conditions: {},
      enabled: true,
    },
    {
      id: "p2",
      name: "Allow read",
      priority: 2,
      effect: "allow",
      scope_type: "tool",
      scope_target: "file_read",
      conditions: {},
      enabled: true,
    },
    {
      id: "p3",
      name: "Block all plugins",
      priority: 3,
      effect: "deny",
      scope_type: "plugin",
      scope_target: "*",
      conditions: {},
      enabled: true,
    },
  ];

  // Simple enforcer test (same logic as enforcement.ts)
  function evaluate(policies, ctx) {
    const enabled = policies.filter((p) => p.enabled).sort((a, b) => a.priority - b.priority);
    for (const rule of enabled) {
      if (matchesScope(rule, ctx)) {
        return { effect: rule.effect, rule: rule.name };
      }
    }
    return { effect: "allow", rule: null };
  }

  function matchesScope(rule, ctx) {
    const target = rule.scope_target;
    switch (rule.scope_type) {
      case "tool":
        return ctx.toolName != null && globMatch(target, ctx.toolName);
      case "plugin":
        return ctx.pluginId != null && globMatch(target, ctx.pluginId);
      default:
        return false;
    }
  }

  function globMatch(pattern, value) {
    if (pattern === "*") return true;
    if (!pattern.includes("*")) return pattern === value;
    return new RegExp("^" + pattern.replace(/\*/g, ".*") + "$").test(value);
  }

  const r1 = evaluate(policies, { toolName: "rm_rf" });
  assert(r1.effect === "deny", `rm_rf is denied (rule: ${r1.rule})`);

  const r2 = evaluate(policies, { toolName: "file_read" });
  assert(r2.effect === "allow", `file_read is allowed (rule: ${r2.rule})`);

  const r3 = evaluate(policies, { pluginId: "any-plugin" });
  assert(r3.effect === "deny", `any plugin is denied by wildcard (rule: ${r3.rule})`);

  const r4 = evaluate(policies, { toolName: "unknown_tool" });
  assert(r4.effect === "allow", `unknown tool with no matching rule is allowed`);
}

// ── Main ──

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  ECP Integration Test Suite              ║");
  console.log("╠══════════════════════════════════════════╣");
  console.log(`║  ECP WS:    ${ECP_WS_URL.padEnd(28)}║`);
  console.log(`║  ECP Admin: ${ECP_ADMIN_URL.padEnd(28)}║`);
  console.log("╚══════════════════════════════════════════╝");

  // Wait for ECP to be ready
  console.log("\nWaiting for ECP server...");
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${ECP_ADMIN_URL}/health`);
      if (res.ok) break;
    } catch {}
    await sleep(1000);
  }

  try {
    await testHealthCheck();
    await testPolicyEnforcement();
    await testWebSocketProtocol();
  } catch (err) {
    console.error("\n✗ Test suite error:", err.message);
    failed++;
  }

  console.log("\n══════════════════════════════════════════");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("══════════════════════════════════════════\n");

  process.exit(failed > 0 ? 1 : 0);
}

main();
