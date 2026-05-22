import type {
  CreateSandboxBackendParams,
  SandboxBackendHandle,
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
} from "./backend.types.js";
import { executeJs, extractInlineScript } from "./wasm-js-runtime.js";
import { executePython, extractPythonScript } from "./wasm-python-runtime.js";

export type WasmIsolationMode = "shared" | "per-exec";

export type WasmBackendConfig = {
  isolationMode?: WasmIsolationMode;
  pythonEnabled?: boolean;
  jsEnabled?: boolean;
  memoryLimitMb?: number;
  execTimeoutMs?: number;
};

type WasmVirtualFs = Map<string, Buffer>;

function resolvePath(p: string): string {
  const parts = p.replace(/\/+/g, "/").split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") resolved.pop();
    else if (part && part !== ".") resolved.push(part);
  }
  return "/" + resolved.join("/");
}

function readVirtualFile(fs: WasmVirtualFs, filePath: string): Buffer | null {
  return fs.get(resolvePath(filePath)) ?? null;
}

function listVirtualDir(fs: WasmVirtualFs, dirPath: string): string[] {
  const prefix = resolvePath(dirPath).replace(/\/$/, "") + "/";
  const entries: string[] = [];
  for (const key of fs.keys()) {
    if (key.startsWith(prefix)) {
      const relative = key.slice(prefix.length);
      const topLevel = relative.split("/")[0];
      if (topLevel && !entries.includes(topLevel)) {
        entries.push(topLevel);
      }
    }
  }
  return entries;
}

const UNSUPPORTED_COMMANDS = [
  "git",
  "curl",
  "wget",
  "apt",
  "apt-get",
  "yum",
  "brew",
  "npm",
  "pnpm",
  "yarn",
  "pip",
  "pip3",
  "cargo",
  "go",
  "docker",
  "kubectl",
  "ssh",
  "scp",
  "rsync",
  "make",
  "cmake",
  "gcc",
  "g++",
  "clang",
];

function isUnsupportedCommand(script: string): string | null {
  const firstWord = script.trim().split(/\s+/)[0]?.toLowerCase();
  if (!firstWord) return null;
  const baseName = firstWord.split("/").pop() ?? firstWord;
  return UNSUPPORTED_COMMANDS.includes(baseName) ? baseName : null;
}

function detectRuntime(script: string): "python" | "js" | "shell" {
  const trimmed = script.trim();
  if (trimmed.startsWith("python3 -c ") || trimmed.startsWith("python -c ")) {
    return "python";
  }
  if (trimmed.startsWith("node -e ") || trimmed.startsWith("deno -e ")) {
    return "js";
  }
  return "shell";
}

async function runJs(
  script: string,
  fs: WasmVirtualFs,
  timeoutMs: number,
): Promise<SandboxBackendCommandResult> {
  const extracted = extractInlineScript(script);
  if (!extracted) {
    return {
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(
        `[wasm-sandbox] Only inline JS execution is supported (node -e '...').\n` +
          `File-based execution is not available in WASM backend.\n`,
      ),
      code: 126,
    };
  }
  const result = await executeJs(extracted.script, {
    timeoutMs,
    virtualFs: fs,
    workdir: "/workspace",
  });
  return {
    stdout: Buffer.from(result.stdout),
    stderr: Buffer.from(result.stderr),
    code: result.code,
  };
}

async function runPython(
  script: string,
  fs: WasmVirtualFs,
  timeoutMs: number,
): Promise<SandboxBackendCommandResult> {
  const extracted = extractPythonScript(script);
  if (!extracted) {
    return {
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(
        `[wasm-sandbox] Only inline Python execution is supported (python3 -c '...').\n` +
          `File-based execution is not available in WASM backend.\n`,
      ),
      code: 126,
    };
  }
  const result = await executePython(extracted, {
    timeoutMs,
    virtualFs: fs,
    workdir: "/workspace",
  });
  return {
    stdout: Buffer.from(result.stdout),
    stderr: Buffer.from(result.stderr),
    code: result.code,
  };
}

function buildShellResult(script: string, fs: WasmVirtualFs): SandboxBackendCommandResult {
  const trimmed = script.trim();

  if (trimmed.startsWith("echo ")) {
    const content = trimmed.slice(5).replace(/^['"]|['"]$/g, "");
    return { stdout: Buffer.from(content + "\n"), stderr: Buffer.alloc(0), code: 0 };
  }

  if (trimmed.startsWith("cat ")) {
    const filePath = trimmed.slice(4).trim();
    const content = readVirtualFile(fs, filePath);
    if (content) {
      return { stdout: content, stderr: Buffer.alloc(0), code: 0 };
    }
    return {
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(`cat: ${filePath}: No such file\n`),
      code: 1,
    };
  }

  if (trimmed === "ls" || trimmed.startsWith("ls ")) {
    const dir = trimmed === "ls" ? "/workspace" : trimmed.slice(3).trim();
    const entries = listVirtualDir(fs, dir);
    return {
      stdout: Buffer.from(entries.join("\n") + (entries.length ? "\n" : "")),
      stderr: Buffer.alloc(0),
      code: 0,
    };
  }

  if (trimmed === "pwd") {
    return { stdout: Buffer.from("/workspace\n"), stderr: Buffer.alloc(0), code: 0 };
  }

  return {
    stdout: Buffer.alloc(0),
    stderr: Buffer.from(
      `[wasm-sandbox] Unsupported shell command in WASM backend.\n` +
        `Only Python (python3 -c '...') and JavaScript (node -e '...') execution is supported.\n` +
        `Unsupported: ${trimmed.split(/\s+/)[0]}\n`,
    ),
    code: 126,
  };
}

export async function createWasmSandboxBackend(
  params: CreateSandboxBackendParams,
): Promise<SandboxBackendHandle> {
  const { sessionKey } = params;
  const fs: WasmVirtualFs = new Map();
  const config: WasmBackendConfig = (params.cfg as any).wasm ?? {};
  const timeoutMs = config.execTimeoutMs ?? 30_000;
  const pythonEnabled = config.pythonEnabled ?? true;
  const jsEnabled = config.jsEnabled ?? true;

  const handle: SandboxBackendHandle = {
    id: "wasm",
    runtimeId: `wasm-${sessionKey}`,
    runtimeLabel: `WASM sandbox (${sessionKey.slice(0, 8)})`,
    workdir: "/workspace",
    capabilities: {
      browser: false,
    },

    async buildExecSpec(execParams) {
      return {
        argv: ["wasm-exec", "--script", execParams.command],
        env: { ...execParams.env },
        stdinMode: "pipe-closed" as const,
      };
    },

    async runShellCommand(
      cmdParams: SandboxBackendCommandParams,
    ): Promise<SandboxBackendCommandResult> {
      const { script } = cmdParams;

      const unsupported = isUnsupportedCommand(script);
      if (unsupported) {
        return {
          stdout: Buffer.alloc(0),
          stderr: Buffer.from(
            `[wasm-sandbox] Command "${unsupported}" is not available in WASM backend.\n` +
              `Native binaries cannot run in WASM. Use the Docker backend for full shell access.\n`,
          ),
          code: 127,
        };
      }

      const runtime = detectRuntime(script);

      switch (runtime) {
        case "js":
          if (!jsEnabled) {
            return {
              stdout: Buffer.alloc(0),
              stderr: Buffer.from("[wasm-sandbox] JavaScript execution is disabled.\n"),
              code: 126,
            };
          }
          return runJs(script, fs, timeoutMs);
        case "python":
          if (!pythonEnabled) {
            return {
              stdout: Buffer.alloc(0),
              stderr: Buffer.from("[wasm-sandbox] Python execution is disabled.\n"),
              code: 126,
            };
          }
          return runPython(script, fs, timeoutMs);
        case "shell":
          return buildShellResult(script, fs);
      }
    },
  };

  return handle;
}
