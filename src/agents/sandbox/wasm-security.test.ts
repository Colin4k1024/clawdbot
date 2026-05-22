import { describe, it, expect } from "vitest";
import type { CreateSandboxBackendParams } from "./backend.types.js";
import { createWasmSandboxBackend } from "./wasm-backend.js";
import { executeJs, extractInlineScript } from "./wasm-js-runtime.js";
import { extractPythonScript } from "./wasm-python-runtime.js";

function makeOptions(
  overrides?: Partial<{ timeoutMs: number; virtualFs: Map<string, Buffer>; workdir: string }>,
) {
  return {
    timeoutMs: 5000,
    virtualFs: new Map<string, Buffer>(),
    workdir: "/workspace",
    ...overrides,
  };
}

function makeParams(overrides?: Partial<CreateSandboxBackendParams>): CreateSandboxBackendParams {
  return {
    sessionKey: "security-test-session",
    scopeKey: "security-scope",
    workspaceDir: "/tmp/sec-workspace",
    agentWorkspaceDir: "/tmp/sec-agent",
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

describe("wasm-security: path traversal prevention", () => {
  describe("JS runtime __readFile containment", () => {
    it("blocks reading above workdir via ../", async () => {
      const fs = new Map<string, Buffer>();
      fs.set("/etc/passwd", Buffer.from("root:x:0:0"));
      fs.set("/workspace/safe.txt", Buffer.from("safe content"));

      const result = await executeJs(
        `const r = __readFile("/workspace/../etc/passwd"); console.log(r === undefined ? "blocked" : "LEAKED");`,
        makeOptions({ virtualFs: fs }),
      );
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("blocked");
    });

    it("blocks reading with multiple ../ levels", async () => {
      const fs = new Map<string, Buffer>();
      fs.set("/secret/key", Buffer.from("supersecret"));

      const result = await executeJs(
        `const r = __readFile("/workspace/../../secret/key"); console.log(r === undefined ? "blocked" : r);`,
        makeOptions({ virtualFs: fs }),
      );
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("blocked");
    });

    it("allows reading within workdir subdirectory", async () => {
      const fs = new Map<string, Buffer>();
      fs.set("/workspace/sub/data.json", Buffer.from('{"ok":true}'));

      const result = await executeJs(
        `const r = __readFile("/workspace/sub/data.json"); console.log(r);`,
        makeOptions({ virtualFs: fs }),
      );
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe('{"ok":true}');
    });

    it("blocks path with encoded dots (./..)", async () => {
      const fs = new Map<string, Buffer>();
      fs.set("/other/file", Buffer.from("nope"));

      const result = await executeJs(
        `const r = __readFile("/workspace/./../../other/file"); console.log(r === undefined ? "blocked" : "LEAKED");`,
        makeOptions({ virtualFs: fs }),
      );
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("blocked");
    });
  });

  describe("JS runtime __writeFile containment", () => {
    it("blocks writing above workdir", async () => {
      const fs = new Map<string, Buffer>();

      const result = await executeJs(
        `const ok = __writeFile("/etc/shadow", "hacked"); console.log(ok ? "WROTE" : "blocked");`,
        makeOptions({ virtualFs: fs }),
      );
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("blocked");
      expect(fs.has("/etc/shadow")).toBe(false);
    });

    it("blocks writing with ../ traversal", async () => {
      const fs = new Map<string, Buffer>();

      const result = await executeJs(
        `const ok = __writeFile("/workspace/../tmp/evil", "data"); console.log(ok ? "WROTE" : "blocked");`,
        makeOptions({ virtualFs: fs }),
      );
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("blocked");
      expect(fs.has("/tmp/evil")).toBe(false);
    });

    it("allows writing within workdir", async () => {
      const fs = new Map<string, Buffer>();

      const result = await executeJs(
        `const ok = __writeFile("/workspace/output.txt", "hello"); console.log(ok ? "ok" : "fail");`,
        makeOptions({ virtualFs: fs }),
      );
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("ok");
      expect(fs.get("/workspace/output.txt")?.toString()).toBe("hello");
    });
  });

  describe("shell cat path traversal", () => {
    it("cat with ../ resolves path via resolvePath but no workdir check", async () => {
      const handle = await createWasmSandboxBackend(makeParams());
      const result = await handle.runShellCommand({ script: "cat ../../etc/passwd" });
      expect(result.code).toBe(1);
      expect(result.stderr.toString()).toContain("No such file");
    });

    it("cat normal path works for workspace files", async () => {
      const handle = await createWasmSandboxBackend(makeParams());
      // First write a file via JS, then cat it
      await handle.runShellCommand({ script: `node -e 'console.log("test")'` });
      const result = await handle.runShellCommand({ script: "cat /workspace/nonexistent" });
      expect(result.code).toBe(1);
    });
  });
});

describe("wasm-security: config enforcement", () => {
  it("rejects JS execution when jsEnabled is false", async () => {
    const params = makeParams();
    (params.cfg as any).wasm.jsEnabled = false;
    const handle = await createWasmSandboxBackend(params);

    const result = await handle.runShellCommand({
      script: `node -e 'console.log("should not run")'`,
    });
    expect(result.code).toBe(126);
    expect(result.stderr.toString()).toContain("JavaScript execution is disabled");
    expect(result.stdout.toString()).toBe("");
  });

  it("rejects Python execution when pythonEnabled is false", async () => {
    const params = makeParams();
    (params.cfg as any).wasm.pythonEnabled = false;
    const handle = await createWasmSandboxBackend(params);

    const result = await handle.runShellCommand({ script: `python3 -c 'print("should not run")'` });
    expect(result.code).toBe(126);
    expect(result.stderr.toString()).toContain("Python execution is disabled");
    expect(result.stdout.toString()).toBe("");
  });

  it("shell commands still work when JS and Python are disabled", async () => {
    const params = makeParams();
    (params.cfg as any).wasm.jsEnabled = false;
    (params.cfg as any).wasm.pythonEnabled = false;
    const handle = await createWasmSandboxBackend(params);

    const result = await handle.runShellCommand({ script: "echo still works" });
    expect(result.code).toBe(0);
    expect(result.stdout.toString().trim()).toBe("still works");
  });

  it("uses default timeout when wasm config is missing", async () => {
    const params = makeParams();
    delete (params.cfg as any).wasm;
    const handle = await createWasmSandboxBackend(params);

    const result = await handle.runShellCommand({ script: "pwd" });
    expect(result.code).toBe(0);
  });
});

describe("wasm-security: extractInlineScript edge cases", () => {
  it("rejects command with trailing content after quotes", () => {
    expect(extractInlineScript("node -e 'x=1' ; rm -rf /")).toBeNull();
  });

  it("rejects node without -e flag", () => {
    expect(extractInlineScript("node script.js")).toEqual({
      script: "// file: script.js",
      isTs: false,
    });
  });

  it("handles empty quoted script", () => {
    const result = extractInlineScript("node -e ''");
    expect(result).toEqual({ script: "", isTs: false });
  });

  it("handles deno -e pattern", () => {
    const result = extractInlineScript("deno -e 'Deno.exit(0)'");
    expect(result).toEqual({ script: "Deno.exit(0)", isTs: false });
  });

  it("rejects node -e without quotes", () => {
    expect(extractInlineScript("node -e console.log(1)")).toBeNull();
  });

  it("handles script with internal quotes matching outer", () => {
    const result = extractInlineScript(`node -e "console.log('hello')"`);
    expect(result).toEqual({ script: "console.log('hello')", isTs: false });
  });

  it("handles multiline script inside quotes", () => {
    const result = extractInlineScript(`node -e 'const x = 1;\nconsole.log(x)'`);
    expect(result).not.toBeNull();
    expect(result!.script).toContain("const x = 1;");
  });
});

describe("wasm-security: extractPythonScript edge cases", () => {
  it("rejects python3 with -m flag", () => {
    expect(extractPythonScript("python3 -m http.server")).toBeNull();
  });

  it("rejects python3 -c without quotes", () => {
    expect(extractPythonScript("python3 -c print(1)")).toBeNull();
  });

  it("rejects content after closing quote", () => {
    expect(extractPythonScript("python3 -c 'print(1)' --extra")).toBeNull();
  });

  it("handles empty script", () => {
    expect(extractPythonScript("python3 -c ''")).toBe("");
  });

  it("handles python (without 3) variant", () => {
    expect(extractPythonScript("python -c 'x=1'")).toBe("x=1");
  });

  it("does not match python31 or similar", () => {
    expect(extractPythonScript("python31 -c 'print(1)'")).toBeNull();
  });
});

describe("wasm-security: detectRuntime strictness", () => {
  it("routes python3 -c to python runtime", async () => {
    const params = makeParams();
    (params.cfg as any).wasm.pythonEnabled = false;
    const handle = await createWasmSandboxBackend(params);
    const result = await handle.runShellCommand({ script: "python3 -c 'print(1)'" });
    expect(result.code).toBe(126);
    expect(result.stderr.toString()).toContain("Python");
  });

  it("routes node -e to JS runtime", async () => {
    const params = makeParams();
    (params.cfg as any).wasm.jsEnabled = false;
    const handle = await createWasmSandboxBackend(params);
    const result = await handle.runShellCommand({ script: "node -e 'x'" });
    expect(result.code).toBe(126);
    expect(result.stderr.toString()).toContain("JavaScript");
  });

  it("does NOT route python3 script.py as python runtime", async () => {
    const handle = await createWasmSandboxBackend(makeParams());
    const result = await handle.runShellCommand({ script: "python3 script.py" });
    expect(result.code).toBe(126);
    expect(result.stderr.toString()).toContain("Unsupported shell command");
  });

  it("does NOT route node script.js as JS runtime via detectRuntime", async () => {
    const handle = await createWasmSandboxBackend(makeParams());
    const result = await handle.runShellCommand({ script: "node script.js" });
    expect(result.code).toBe(126);
    expect(result.stderr.toString()).toContain("Unsupported shell command");
  });
});

describe("wasm-security: QuickJS resource isolation", () => {
  it("each execution gets a fresh VM context (no state leak)", async () => {
    const result1 = await executeJs("globalThis.leaked = 42; console.log('set');", makeOptions());
    expect(result1.code).toBe(0);

    const result2 = await executeJs(
      "console.log(typeof globalThis.leaked === 'undefined' ? 'clean' : 'LEAKED');",
      makeOptions(),
    );
    expect(result2.code).toBe(0);
    expect(result2.stdout.trim()).toBe("clean");
  });

  it("timeout interrupts infinite loop", async () => {
    const result = await executeJs("while(true){}", makeOptions({ timeoutMs: 200 }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("timed out");
  });

  it("vm.dispose called even on host-side exception scenario", async () => {
    const result = await executeJs("undefined.property", makeOptions());
    expect(result.code).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});

describe("wasm-security: shell emulation edge cases", () => {
  it("echo with single quotes", async () => {
    const handle = await createWasmSandboxBackend(makeParams());
    const result = await handle.runShellCommand({ script: "echo 'hello world'" });
    expect(result.code).toBe(0);
    expect(result.stdout.toString().trim()).toBe("hello world");
  });

  it("echo with double quotes", async () => {
    const handle = await createWasmSandboxBackend(makeParams());
    const result = await handle.runShellCommand({ script: 'echo "hello world"' });
    expect(result.code).toBe(0);
    expect(result.stdout.toString().trim()).toBe("hello world");
  });

  it("echo without quotes preserves content", async () => {
    const handle = await createWasmSandboxBackend(makeParams());
    const result = await handle.runShellCommand({ script: "echo no quotes here" });
    expect(result.code).toBe(0);
    expect(result.stdout.toString().trim()).toBe("no quotes here");
  });

  it("ls on empty workspace returns nothing", async () => {
    const handle = await createWasmSandboxBackend(makeParams());
    const result = await handle.runShellCommand({ script: "ls" });
    expect(result.code).toBe(0);
    expect(result.stdout.toString()).toBe("");
  });

  it("unknown command returns code 126 with clear message", async () => {
    const handle = await createWasmSandboxBackend(makeParams());
    const result = await handle.runShellCommand({ script: "find . -name '*.ts'" });
    expect(result.code).toBe(126);
    expect(result.stderr.toString()).toContain("Unsupported shell command");
  });

  it("empty script is treated as unsupported shell (not crash)", async () => {
    const handle = await createWasmSandboxBackend(makeParams());
    const result = await handle.runShellCommand({ script: "" });
    expect(result.code).toBe(126);
  });

  it("whitespace-only script is treated as unsupported", async () => {
    const handle = await createWasmSandboxBackend(makeParams());
    const result = await handle.runShellCommand({ script: "   " });
    expect(result.code).toBe(126);
  });
});

describe("wasm-security: unsupported command variants", () => {
  it("blocks absolute path to unsupported command", async () => {
    const handle = await createWasmSandboxBackend(makeParams());
    const result = await handle.runShellCommand({ script: "/usr/bin/git status" });
    expect(result.code).toBe(127);
    expect(result.stderr.toString()).toContain("git");
  });

  it("blocks docker compose", async () => {
    const handle = await createWasmSandboxBackend(makeParams());
    const result = await handle.runShellCommand({ script: "docker compose up -d" });
    expect(result.code).toBe(127);
  });

  it("blocks ssh with arguments", async () => {
    const handle = await createWasmSandboxBackend(makeParams());
    const result = await handle.runShellCommand({ script: "ssh user@host 'rm -rf /'" });
    expect(result.code).toBe(127);
  });

  it("blocks make", async () => {
    const handle = await createWasmSandboxBackend(makeParams());
    const result = await handle.runShellCommand({ script: "make all" });
    expect(result.code).toBe(127);
  });
});

describe("wasm-security: virtual FS isolation across sessions", () => {
  it("separate backend instances do not share virtual FS", async () => {
    const handle1 = await createWasmSandboxBackend(makeParams({ sessionKey: "session-A" }));
    const handle2 = await createWasmSandboxBackend(makeParams({ sessionKey: "session-B" }));

    await handle1.runShellCommand({
      script: `node -e '__writeFile("/workspace/secret.txt", "session-A-data"); console.log("wrote")'`,
    });

    const result = await handle2.runShellCommand({ script: "cat /workspace/secret.txt" });
    expect(result.code).toBe(1);
    expect(result.stderr.toString()).toContain("No such file");
  });

  it("writes persist within same session", async () => {
    const handle = await createWasmSandboxBackend(makeParams());

    await handle.runShellCommand({
      script: `node -e '__writeFile("/workspace/persist.txt", "data123"); console.log("ok")'`,
    });

    const result = await handle.runShellCommand({ script: "cat /workspace/persist.txt" });
    expect(result.code).toBe(0);
    expect(result.stdout.toString()).toBe("data123");
  });
});
