import { describe, it, expect } from "vitest";
import type { CreateSandboxBackendParams } from "./backend.types.js";
import { createWasmSandboxBackend } from "./wasm-backend.js";

function makeParams(overrides?: Partial<CreateSandboxBackendParams>): CreateSandboxBackendParams {
  return {
    sessionKey: "integration-test-session",
    scopeKey: "integration-scope",
    workspaceDir: "/tmp/integration-workspace",
    agentWorkspaceDir: "/tmp/integration-agent",
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

describe("wasm-backend integration", () => {
  describe("JS execution end-to-end", () => {
    it("executes JS with console output and returns correct result", async () => {
      const handle = await createWasmSandboxBackend(makeParams());
      const result = await handle.runShellCommand({
        script: `node -e 'const arr = [1,2,3,4,5]; console.log(arr.reduce((a,b) => a+b, 0))'`,
      });
      expect(result.code).toBe(0);
      expect(result.stdout.toString().trim()).toBe("15");
    });

    it("handles multiple sequential JS commands", async () => {
      const handle = await createWasmSandboxBackend(makeParams());

      const r1 = await handle.runShellCommand({ script: `node -e 'console.log("first")'` });
      expect(r1.code).toBe(0);
      expect(r1.stdout.toString().trim()).toBe("first");

      const r2 = await handle.runShellCommand({ script: `node -e 'console.log("second")'` });
      expect(r2.code).toBe(0);
      expect(r2.stdout.toString().trim()).toBe("second");
    });

    it("JS errors do not crash subsequent commands", async () => {
      const handle = await createWasmSandboxBackend(makeParams());

      const r1 = await handle.runShellCommand({ script: `node -e 'throw new Error("oops")'` });
      expect(r1.code).toBe(1);
      expect(r1.stderr.toString()).toContain("oops");

      const r2 = await handle.runShellCommand({ script: `node -e 'console.log("still works")'` });
      expect(r2.code).toBe(0);
      expect(r2.stdout.toString().trim()).toBe("still works");
    });
  });

  describe("shell emulation end-to-end", () => {
    it("echo with special characters", async () => {
      const handle = await createWasmSandboxBackend(makeParams());
      const result = await handle.runShellCommand({ script: "echo hello world 123" });
      expect(result.code).toBe(0);
      expect(result.stdout.toString().trim()).toBe("hello world 123");
    });

    it("pwd returns workspace root", async () => {
      const handle = await createWasmSandboxBackend(makeParams());
      const result = await handle.runShellCommand({ script: "pwd" });
      expect(result.code).toBe(0);
      expect(result.stdout.toString().trim()).toBe("/workspace");
    });
  });

  describe("command routing", () => {
    it("blocks git commands with clear error message", async () => {
      const handle = await createWasmSandboxBackend(makeParams());
      const result = await handle.runShellCommand({ script: "git log --oneline" });
      expect(result.code).toBe(127);
      expect(result.stderr.toString()).toContain("not available in WASM backend");
      expect(result.stderr.toString()).toContain("git");
    });

    it("blocks network commands", async () => {
      const handle = await createWasmSandboxBackend(makeParams());

      const curl = await handle.runShellCommand({ script: "curl https://api.example.com" });
      expect(curl.code).toBe(127);

      const wget = await handle.runShellCommand({ script: "wget https://example.com/file" });
      expect(wget.code).toBe(127);
    });

    it("blocks package managers", async () => {
      const handle = await createWasmSandboxBackend(makeParams());

      for (const cmd of ["npm install express", "pip install requests", "cargo build"]) {
        const result = await handle.runShellCommand({ script: cmd });
        expect(result.code).toBe(127);
        expect(result.stderr.toString()).toContain("not available in WASM backend");
      }
    });

    it("unrecognized commands get code 126", async () => {
      const handle = await createWasmSandboxBackend(makeParams());
      const result = await handle.runShellCommand({ script: "myCustomTool --flag" });
      expect(result.code).toBe(126);
      expect(result.stderr.toString()).toContain("Unsupported shell command");
    });
  });

  describe("capabilities and metadata", () => {
    it("reports correct capabilities", async () => {
      const handle = await createWasmSandboxBackend(makeParams());
      expect(handle.capabilities?.browser).toBe(false);
      expect(handle.id).toBe("wasm");
      expect(handle.workdir).toBe("/workspace");
    });

    it("runtimeId includes session key", async () => {
      const handle = await createWasmSandboxBackend(makeParams({ sessionKey: "abc123" }));
      expect(handle.runtimeId).toContain("wasm-");
      expect(handle.runtimeId).toContain("abc123");
    });

    it("buildExecSpec returns pipe-closed stdin", async () => {
      const handle = await createWasmSandboxBackend(makeParams());
      const spec = await handle.buildExecSpec({ command: "echo test", env: {}, usePty: false });
      expect(spec.stdinMode).toBe("pipe-closed");
      expect(spec.argv).toBeDefined();
    });
  });
});
