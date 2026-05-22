import { describe, it, expect, beforeAll, vi } from "vitest";
import { extractPythonScript } from "./wasm-python-runtime.js";

let pyodideAvailable = false;

beforeAll(async () => {
  try {
    await import("pyodide");
    pyodideAvailable = true;
  } catch {
    pyodideAvailable = false;
  }
});

describe("wasm-python-runtime", () => {
  describe("extractPythonScript", () => {
    it("extracts python3 -c single-quoted script", () => {
      const result = extractPythonScript("python3 -c 'print(42)'");
      expect(result).toBe("print(42)");
    });

    it("extracts python3 -c double-quoted script", () => {
      const result = extractPythonScript('python3 -c "print(42)"');
      expect(result).toBe("print(42)");
    });

    it("extracts python -c script", () => {
      const result = extractPythonScript("python -c 'x = 1; print(x)'");
      expect(result).toBe("x = 1; print(x)");
    });

    it("extracts multiline script content", () => {
      const result = extractPythonScript(`python3 -c 'import sys\nprint(sys.version)'`);
      expect(result).toBe("import sys\nprint(sys.version)");
    });

    it("returns null for non-matching commands", () => {
      expect(extractPythonScript("echo hello")).toBeNull();
      expect(extractPythonScript("node -e 'console.log(1)'")).toBeNull();
      expect(extractPythonScript("python3 script.py")).toBeNull();
      expect(extractPythonScript("pip install requests")).toBeNull();
    });

    it("returns null for python3 without -c flag", () => {
      expect(extractPythonScript("python3 -m pytest")).toBeNull();
      expect(extractPythonScript("python3 --version")).toBeNull();
    });
  });

  describe("executePython (requires pyodide)", () => {
    it.skipIf(!pyodideAvailable)(
      "executes basic arithmetic",
      async () => {
        const { executePython } = await import("./wasm-python-runtime.js");
        const result = await executePython("print(2 + 3)", {
          timeoutMs: 30000,
          virtualFs: new Map(),
          workdir: "/workspace",
        });
        expect(result.code).toBe(0);
        expect(result.stdout.trim()).toBe("5");
      },
      30000,
    );

    it.skipIf(!pyodideAvailable)(
      "captures stderr on exception",
      async () => {
        const { executePython } = await import("./wasm-python-runtime.js");
        const result = await executePython("raise ValueError('test error')", {
          timeoutMs: 30000,
          virtualFs: new Map(),
          workdir: "/workspace",
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("test error");
      },
      30000,
    );

    it.skipIf(!pyodideAvailable)(
      "captures stdout from multiple prints",
      async () => {
        const { executePython } = await import("./wasm-python-runtime.js");
        const result = await executePython("print('hello')\nprint('world')", {
          timeoutMs: 30000,
          virtualFs: new Map(),
          workdir: "/workspace",
        });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("hello");
        expect(result.stdout).toContain("world");
      },
      30000,
    );

    it.skipIf(!pyodideAvailable)(
      "imports stdlib modules",
      async () => {
        const { executePython } = await import("./wasm-python-runtime.js");
        const result = await executePython("import json\nprint(json.dumps({'a': 1}))", {
          timeoutMs: 30000,
          virtualFs: new Map(),
          workdir: "/workspace",
        });
        expect(result.code).toBe(0);
        expect(result.stdout.trim()).toBe('{"a": 1}');
      },
      30000,
    );

    it.skipIf(!pyodideAvailable)(
      "handles syntax errors",
      async () => {
        const { executePython } = await import("./wasm-python-runtime.js");
        const result = await executePython("def foo(\n", {
          timeoutMs: 30000,
          virtualFs: new Map(),
          workdir: "/workspace",
        });
        expect(result.code).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
      },
      30000,
    );

    it.skipIf(!pyodideAvailable)(
      "writes and reads virtual FS",
      async () => {
        const { executePython } = await import("./wasm-python-runtime.js");
        const virtualFs = new Map<string, Buffer>();
        virtualFs.set("/workspace/input.txt", Buffer.from("hello from host"));

        const result = await executePython(
          `
with open('/workspace/input.txt', 'r') as f:
    content = f.read()
print(content)
with open('/workspace/output.txt', 'w') as f:
    f.write('written by python')
`,
          {
            timeoutMs: 30000,
            virtualFs,
            workdir: "/workspace",
          },
        );
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("hello from host");
        expect(virtualFs.get("/workspace/output.txt")?.toString()).toBe("written by python");
      },
      30000,
    );
  });

  describe("disposePyodideInstance", () => {
    it("resets status to idle", async () => {
      const { disposePyodideInstance, getPyodideStatus } = await import("./wasm-python-runtime.js");
      await disposePyodideInstance();
      expect(getPyodideStatus()).toBe("idle");
    });
  });

  describe("getPyodideStatus", () => {
    it("returns idle initially", async () => {
      const { getPyodideStatus, disposePyodideInstance } = await import("./wasm-python-runtime.js");
      await disposePyodideInstance();
      expect(getPyodideStatus()).toBe("idle");
    });
  });
});
