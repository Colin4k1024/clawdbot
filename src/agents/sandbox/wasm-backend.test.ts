import { describe, it, expect } from "vitest";
import type { CreateSandboxBackendParams } from "./backend.types.js";
import { createWasmSandboxBackend } from "./wasm-backend.js";

function makeParams(overrides?: Partial<CreateSandboxBackendParams>): CreateSandboxBackendParams {
  return {
    sessionKey: "test-session-123",
    scopeKey: "test-scope",
    workspaceDir: "/tmp/test-workspace",
    agentWorkspaceDir: "/tmp/test-agent",
    cfg: {
      mode: "all",
      backend: "wasm",
      scope: "session",
      workspaceAccess: "rw",
      workspaceRoot: "/tmp",
      docker: {} as any,
      ssh: {} as any,
      wasm: {
        isolationMode: "per-exec",
        pythonEnabled: true,
        jsEnabled: true,
        memoryLimitMb: 256,
        execTimeoutMs: 5000,
      },
      browser: { enabled: false } as any,
      tools: {},
      prune: { idleHours: 24, maxAgeDays: 7 },
    },
    ...overrides,
  };
}

describe("wasm-backend", () => {
  it("creates a backend handle with correct id and capabilities", async () => {
    const handle = await createWasmSandboxBackend(makeParams());
    expect(handle.id).toBe("wasm");
    expect(handle.capabilities?.browser).toBe(false);
    expect(handle.workdir).toBe("/workspace");
    expect(handle.runtimeId).toContain("wasm-");
  });

  it("buildExecSpec returns correct structure", async () => {
    const handle = await createWasmSandboxBackend(makeParams());
    const spec = await handle.buildExecSpec({
      command: "echo hello",
      env: { FOO: "bar" },
      usePty: false,
    });
    expect(spec.argv).toBeDefined();
    expect(spec.stdinMode).toBe("pipe-closed");
    expect(spec.env).toHaveProperty("FOO", "bar");
  });

  it("rejects unsupported native commands with code 127", async () => {
    const handle = await createWasmSandboxBackend(makeParams());
    const result = await handle.runShellCommand({ script: "git status" });
    expect(result.code).toBe(127);
    expect(result.stderr.toString()).toContain("not available in WASM backend");
  });

  it("rejects curl command", async () => {
    const handle = await createWasmSandboxBackend(makeParams());
    const result = await handle.runShellCommand({ script: "curl https://example.com" });
    expect(result.code).toBe(127);
    expect(result.stderr.toString()).toContain("curl");
  });

  it("handles simple echo via shell emulation", async () => {
    const handle = await createWasmSandboxBackend(makeParams());
    const result = await handle.runShellCommand({ script: "echo hello world" });
    expect(result.code).toBe(0);
    expect(result.stdout.toString().trim()).toBe("hello world");
  });

  it("handles pwd command", async () => {
    const handle = await createWasmSandboxBackend(makeParams());
    const result = await handle.runShellCommand({ script: "pwd" });
    expect(result.code).toBe(0);
    expect(result.stdout.toString().trim()).toBe("/workspace");
  });

  it("returns code 126 for unrecognized shell commands", async () => {
    const handle = await createWasmSandboxBackend(makeParams());
    const result = await handle.runShellCommand({ script: "some_unknown_command arg1" });
    expect(result.code).toBe(126);
    expect(result.stderr.toString()).toContain("Unsupported shell command");
  });

  it("executes JS via QuickJS (node -e pattern)", async () => {
    const handle = await createWasmSandboxBackend(makeParams());
    const result = await handle.runShellCommand({ script: `node -e 'console.log(1+1)'` });
    expect(result.code).toBe(0);
    expect(result.stdout.toString().trim()).toBe("2");
  });

  it("captures JS errors", async () => {
    const handle = await createWasmSandboxBackend(makeParams());
    const result = await handle.runShellCommand({ script: `node -e 'throw new Error("boom")'` });
    expect(result.code).toBe(1);
    expect(result.stderr.toString()).toContain("boom");
  });

  it("executes multi-line JS", async () => {
    const handle = await createWasmSandboxBackend(makeParams());
    const result = await handle.runShellCommand({
      script: `node -e 'const x = 10; const y = 20; console.log(x + y)'`,
    });
    expect(result.code).toBe(0);
    expect(result.stdout.toString().trim()).toBe("30");
  });
});
