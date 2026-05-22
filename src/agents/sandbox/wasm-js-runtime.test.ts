import { describe, it, expect } from "vitest";
import { executeJs, executeTs, extractInlineScript } from "./wasm-js-runtime.js";
import type { JsRuntimeOptions } from "./wasm-js-runtime.js";

function makeOptions(overrides?: Partial<JsRuntimeOptions>): JsRuntimeOptions {
  return {
    timeoutMs: 5000,
    virtualFs: new Map(),
    workdir: "/workspace",
    ...overrides,
  };
}

describe("wasm-js-runtime", () => {
  describe("executeJs", () => {
    it("executes basic arithmetic", async () => {
      const result = await executeJs("console.log(2 + 3)", makeOptions());
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("5");
    });

    it("captures multiple console.log calls", async () => {
      const result = await executeJs(`console.log("hello"); console.log("world");`, makeOptions());
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("hello");
      expect(result.stdout).toContain("world");
    });

    it("captures console.error to stderr", async () => {
      const result = await executeJs(`console.error("oops")`, makeOptions());
      expect(result.code).toBe(0);
      expect(result.stderr.trim()).toBe("oops");
    });

    it("captures console.warn to stderr", async () => {
      const result = await executeJs(`console.warn("warning!")`, makeOptions());
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("warning!");
    });

    it("reports errors with code 1", async () => {
      const result = await executeJs(`throw new Error("fail")`, makeOptions());
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("fail");
    });

    it("handles syntax errors", async () => {
      const result = await executeJs(`function (`, makeOptions());
      expect(result.code).toBe(1);
      expect(result.stderr.length).toBeGreaterThan(0);
    });

    it("interrupts infinite loops", async () => {
      const result = await executeJs(`while(true) {}`, makeOptions({ timeoutMs: 100 }));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("timed out");
    });

    it("provides __readFile for virtual FS", async () => {
      const fs = new Map<string, Buffer>();
      fs.set("/workspace/test.txt", Buffer.from("hello from file"));
      const result = await executeJs(
        `const content = __readFile("/workspace/test.txt"); console.log(content);`,
        makeOptions({ virtualFs: fs }),
      );
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("hello from file");
    });

    it("provides __writeFile for virtual FS", async () => {
      const fs = new Map<string, Buffer>();
      const result = await executeJs(
        `__writeFile("/workspace/out.txt", "written content"); console.log("done");`,
        makeOptions({ virtualFs: fs }),
      );
      expect(result.code).toBe(0);
      expect(fs.get("/workspace/out.txt")?.toString()).toBe("written content");
    });

    it("returns undefined for missing files", async () => {
      const result = await executeJs(
        `const r = __readFile("/nope"); console.log(r === undefined ? "missing" : "found");`,
        makeOptions(),
      );
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("missing");
    });

    it("executes complex scripts", async () => {
      const script = `
        function fib(n) { return n <= 1 ? n : fib(n-1) + fib(n-2); }
        console.log(fib(10));
      `;
      const result = await executeJs(script, makeOptions());
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("55");
    });
  });

  describe("executeTs", () => {
    it("transpiles and executes TypeScript", async () => {
      const script = `
        const x: number = 42;
        console.log(x);
      `;
      const result = await executeTs(script, makeOptions());
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("42");
    });

    it("handles type annotations", async () => {
      const script = `
        interface Foo { bar: string; }
        const obj: Foo = { bar: "hello" };
        console.log(obj.bar);
      `;
      const result = await executeTs(script, makeOptions());
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("hello");
    });
  });

  describe("extractInlineScript", () => {
    it("extracts node -e single-quoted script", () => {
      const r = extractInlineScript("node -e 'console.log(1)'");
      expect(r).toEqual({ script: "console.log(1)", isTs: false });
    });

    it("extracts node -e double-quoted script", () => {
      const r = extractInlineScript('node -e "console.log(2)"');
      expect(r).toEqual({ script: "console.log(2)", isTs: false });
    });

    it("returns null for non-matching commands", () => {
      expect(extractInlineScript("echo hello")).toBeNull();
      expect(extractInlineScript("python3 -c 'print(1)'")).toBeNull();
    });
  });
});
