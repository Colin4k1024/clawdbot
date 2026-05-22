import { getQuickJS, type QuickJSWASMModule, type QuickJSContext } from "quickjs-emscripten";

export type JsRuntimeOptions = {
  timeoutMs: number;
  virtualFs: Map<string, Buffer>;
  workdir: string;
};

export type JsRuntimeResult = {
  stdout: string;
  stderr: string;
  code: number;
};

let cachedQuickJS: QuickJSWASMModule | null = null;
let quickJsLoadPromise: Promise<QuickJSWASMModule> | null = null;

async function getOrCreateQuickJS(): Promise<QuickJSWASMModule> {
  if (cachedQuickJS) return cachedQuickJS;
  if (quickJsLoadPromise) return quickJsLoadPromise;

  quickJsLoadPromise = (async () => {
    try {
      cachedQuickJS = await getQuickJS();
      return cachedQuickJS;
    } catch (e) {
      quickJsLoadPromise = null;
      throw e;
    }
  })();

  return quickJsLoadPromise;
}

function setupConsole(vm: QuickJSContext, stdout: string[], stderr: string[]): void {
  const consoleObj = vm.newObject();

  const logFn = vm.newFunction("log", (...args) => {
    stdout.push(args.map((a) => vm.dump(a)).join(" "));
  });
  const errorFn = vm.newFunction("error", (...args) => {
    stderr.push(args.map((a) => vm.dump(a)).join(" "));
  });
  const warnFn = vm.newFunction("warn", (...args) => {
    stderr.push(args.map((a) => vm.dump(a)).join(" "));
  });
  const infoFn = vm.newFunction("info", (...args) => {
    stdout.push(args.map((a) => vm.dump(a)).join(" "));
  });

  vm.setProp(consoleObj, "log", logFn);
  vm.setProp(consoleObj, "error", errorFn);
  vm.setProp(consoleObj, "warn", warnFn);
  vm.setProp(consoleObj, "info", infoFn);
  vm.setProp(vm.global, "console", consoleObj);

  consoleObj.dispose();
  logFn.dispose();
  errorFn.dispose();
  warnFn.dispose();
  infoFn.dispose();
}

function setupFileIO(vm: QuickJSContext, virtualFs: Map<string, Buffer>, workdir: string): void {
  const readFileFn = vm.newFunction("__readFile", (...args) => {
    const path = vm.dump(args[0]);
    const resolved = resolvePath(path);
    if (!isWithinWorkdir(resolved, workdir)) {
      return vm.undefined;
    }
    const content = virtualFs.get(resolved);
    if (content) {
      return vm.newString(content.toString("utf-8"));
    }
    return vm.undefined;
  });

  const writeFileFn = vm.newFunction("__writeFile", (...args) => {
    const path = vm.dump(args[0]);
    const resolved = resolvePath(path);
    if (!isWithinWorkdir(resolved, workdir)) {
      return vm.false;
    }
    const content = vm.dump(args[1]);
    virtualFs.set(resolved, Buffer.from(String(content), "utf-8"));
    return vm.true;
  });

  vm.setProp(vm.global, "__readFile", readFileFn);
  vm.setProp(vm.global, "__writeFile", writeFileFn);

  readFileFn.dispose();
  writeFileFn.dispose();
}

function resolvePath(p: string): string {
  const parts = p.replace(/\/+/g, "/").split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") resolved.pop();
    else if (part && part !== ".") resolved.push(part);
  }
  return "/" + resolved.join("/");
}

function isWithinWorkdir(path: string, workdir: string): boolean {
  const resolved = resolvePath(path);
  const base = resolvePath(workdir);
  return resolved === base || resolved.startsWith(base + "/");
}

export async function executeJs(
  script: string,
  options: JsRuntimeOptions,
): Promise<JsRuntimeResult> {
  const { timeoutMs, virtualFs, workdir } = options;
  const QuickJS = await getOrCreateQuickJS();
  const vm = QuickJS.newContext();

  const stdout: string[] = [];
  const stderr: string[] = [];

  setupConsole(vm, stdout, stderr);
  setupFileIO(vm, virtualFs, workdir);

  // Inject __dirname and __filename equivalents
  const dirnameHandle = vm.newString(workdir);
  vm.setProp(vm.global, "__workdir", dirnameHandle);
  dirnameHandle.dispose();

  // Timeout via interrupt handler
  const deadline = Date.now() + timeoutMs;
  vm.runtime.setInterruptHandler(() => {
    if (Date.now() > deadline) {
      return true;
    }
    return false;
  });

  let code = 0;
  try {
    const result = vm.evalCode(script);

    if (result.error) {
      const err = vm.dump(result.error);
      const msg = typeof err === "object" ? (err.message ?? JSON.stringify(err)) : String(err);
      if (Date.now() > deadline) {
        stderr.push(`Execution timed out after ${timeoutMs}ms`);
      } else {
        stderr.push(msg);
      }
      code = 1;
      result.error.dispose();
    } else {
      result.value.dispose();
    }
  } finally {
    vm.dispose();
  }

  return {
    stdout: stdout.join("\n") + (stdout.length > 0 ? "\n" : ""),
    stderr: stderr.join("\n") + (stderr.length > 0 ? "\n" : ""),
    code,
  };
}

export async function executeTs(
  script: string,
  options: JsRuntimeOptions,
): Promise<JsRuntimeResult> {
  let jsCode: string;
  try {
    const esbuild = await import("esbuild");
    const result = await esbuild.transform(script, {
      loader: "ts",
      target: "es2020",
      format: "esm",
    });
    jsCode = result.code;
  } catch {
    // Fallback: try executing as-is (might work if no TS-specific syntax)
    jsCode = script;
  }
  return executeJs(jsCode, options);
}

export function extractInlineScript(command: string): { script: string; isTs: boolean } | null {
  // node -e '...' or node -e "..."
  const nodeMatch = command.match(/^(?:node|deno)\s+-e\s+(['"])([\s\S]*?)\1\s*$/);
  if (nodeMatch) {
    return { script: nodeMatch[2], isTs: false };
  }

  // node script.ts or node script.js
  const fileMatch = command.match(/^(?:node|deno|npx\s+tsx)\s+(.+\.(ts|js))$/);
  if (fileMatch) {
    return { script: `// file: ${fileMatch[1]}`, isTs: fileMatch[2] === "ts" };
  }

  return null;
}
