export type PythonRuntimeOptions = {
  timeoutMs: number;
  virtualFs: Map<string, Buffer>;
  workdir: string;
};

export type PythonRuntimeResult = {
  stdout: string;
  stderr: string;
  code: number;
};

type PyodideStatus = "idle" | "loading" | "ready" | "error";

let pyodideInstance: any = null;
let pyodideStatus: PyodideStatus = "idle";
let loadPromise: Promise<any> | null = null;

async function getOrCreatePyodide(): Promise<any> {
  if (pyodideInstance && pyodideStatus === "ready") {
    return pyodideInstance;
  }

  if (loadPromise && pyodideStatus === "loading") {
    return loadPromise;
  }

  pyodideStatus = "loading";
  loadPromise = (async () => {
    try {
      const { loadPyodide } = await import("pyodide");
      pyodideInstance = await loadPyodide();
      pyodideStatus = "ready";
      return pyodideInstance;
    } catch (e) {
      pyodideStatus = "error";
      loadPromise = null;
      throw e;
    }
  })();

  return loadPromise;
}

function syncVirtualFsToPyodide(
  pyodide: any,
  virtualFs: Map<string, Buffer>,
  workdir: string,
): void {
  try {
    pyodide.FS.mkdir(workdir);
  } catch {
    // directory may already exist
  }

  for (const [path, content] of virtualFs) {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current += "/" + parts[i];
      try {
        pyodide.FS.mkdir(current);
      } catch {
        // exists
      }
    }
    try {
      pyodide.FS.writeFile(path, content);
    } catch {
      // skip on error
    }
  }
}

function syncPyodideFsBack(pyodide: any, virtualFs: Map<string, Buffer>, workdir: string): void {
  try {
    const entries = pyodide.FS.readdir(workdir).filter((e: string) => e !== "." && e !== "..");
    for (const entry of entries) {
      const fullPath = `${workdir}/${entry}`;
      try {
        const stat = pyodide.FS.stat(fullPath);
        if (stat.mode & 0o100000) {
          // regular file
          const content = pyodide.FS.readFile(fullPath);
          virtualFs.set(fullPath, Buffer.from(content));
        }
      } catch {
        // skip
      }
    }
  } catch {
    // workdir may not exist
  }
}

export async function executePython(
  script: string,
  options: PythonRuntimeOptions,
): Promise<PythonRuntimeResult> {
  const { timeoutMs, virtualFs, workdir } = options;

  try {
    const pyodide = await Promise.race([
      getOrCreatePyodide(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Pyodide load timeout")), timeoutMs),
      ),
    ]);

    syncVirtualFsToPyodide(pyodide, virtualFs, workdir);

    // Setup stdout/stderr capture
    pyodide.runPython(`
import sys
from io import StringIO
_wasm_stdout = StringIO()
_wasm_stderr = StringIO()
sys.stdout = _wasm_stdout
sys.stderr = _wasm_stderr
`);

    let code = 0;
    try {
      await Promise.race([
        Promise.resolve(pyodide.runPython(script)),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Python execution timed out after ${timeoutMs}ms`)),
            timeoutMs,
          ),
        ),
      ]);
    } catch (e: any) {
      const errMsg = e.message ?? String(e);
      if (errMsg.includes("timed out")) {
        // Timeout - need to dispose and recreate
        await disposePyodideInstance();
        return {
          stdout: "",
          stderr: `Execution timed out after ${timeoutMs}ms\n`,
          code: 124,
        };
      }
      // Python exception — use globals.set to avoid code injection
      try {
        pyodide.globals.set("_wasm_err_msg", errMsg + "\n");
        pyodide.runPython("_wasm_stderr.write(_wasm_err_msg)");
      } catch {
        // fallback
      }
      code = 1;
    }

    let stdout = "";
    let stderr = "";
    try {
      stdout = pyodide.runPython("_wasm_stdout.getvalue()") as string;
      stderr = pyodide.runPython("_wasm_stderr.getvalue()") as string;
    } catch {
      // capture failed
    }

    // Restore stdout/stderr
    try {
      pyodide.runPython("sys.stdout = sys.__stdout__; sys.stderr = sys.__stderr__");
    } catch {
      // ignore
    }

    syncPyodideFsBack(pyodide, virtualFs, workdir);

    return { stdout, stderr, code };
  } catch (e: any) {
    return {
      stdout: "",
      stderr: `[wasm-python] Runtime error: ${e.message}\n`,
      code: 127,
    };
  }
}

export async function disposePyodideInstance(): Promise<void> {
  pyodideInstance = null;
  loadPromise = null;
  pyodideStatus = "idle";
}

export function getPyodideStatus(): PyodideStatus {
  return pyodideStatus;
}

export function extractPythonScript(command: string): string | null {
  // python3 -c '...' or python -c "..."
  const match = command.match(/^python[3]?\s+-c\s+(['"])([\s\S]*?)\1\s*$/);
  return match?.[2] ?? null;
}
