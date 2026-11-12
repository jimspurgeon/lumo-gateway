// Run: node --test gateway/proxy-errors.test.mjs
// Test proxy uncaughtException/unhandledRejection handlers (#132).
// We spawn child node processes to avoid binding port 8790 and importing proxy.mjs into the runner.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const timeoutMs = 10000; // fail the test if spawn hangs

// Every temp dir this file creates, removed when the file's tests finish (#213).
const tempDirs = [];
const tempDir = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); tempDirs.push(d); return d; };
after(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });

// Spawns a child that imports proxy.mjs then throws/rejects after a short delay.
// CLAUDE_LUMO_STATE_DIR points at a temp dir so the child never creates or prunes
// the real ~/.claude-lumo/logs and ~/.claude-lumo/debug (#134). Every browser location
// (HOME, USERPROFILE, APPDATA, LOCALAPPDATA, XDG_CONFIG_HOME) also points into that temp
// dir and no login env is passed, so the child never opens a real cookie store (#210).
async function spawnProxyCrash({ port, logFile, throwKind }) {
  const code = `import "./proxy.mjs"; setTimeout(() => {
    if (${throwKind === "exception"}) throw new Error("test-uncaught-exception-${port}");
    else Promise.reject(new Error("test-unhandled-rejection-${port}"));
  }, 400);`;
  const root = tempDir("lumo-proxy-state-");
  const stateDir = join(root, "state"), home = join(root, "home");
  for (const d of [stateDir, join(home, "AppData", "Roaming"), join(home, "AppData", "Local"), join(home, ".config")])
    mkdirSync(d, { recursive: true });
  const env = { ...process.env, LUMO_PROXY_PORT: String(port), LUMO_PROXY_LOG: logFile,
    CLAUDE_LUMO_STATE_DIR: stateDir, HOME: home, USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config") };
  for (const k of ["LUMO_TOKEN", "LUMO_UID", "LUMO_FIREFOX_PROFILE"]) delete env[k];
  return new Promise((resolve) => {
    const p = spawn("node", ["--input-type=module", "-e", code], {
      cwd: import.meta.dirname,
      env,
      stdio: ["inherit", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    p.stdout?.on("data", (d) => (stdout += d));
    p.stderr?.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => { p.kill("SIGKILL"); resolve({ timedOut: true, exitCode: null, stdout, stderr }); }, timeoutMs);
    p.on("close", (code) => { clearTimeout(timer); resolve({ timedOut: false, exitCode: code, stdout, stderr }); });
  });
}

test("uncaughtException handler logs synchronously and exits non-zero", async () => {
  const port = 18000 + Math.floor(Math.random() * 500);
  const logFile = join(tempDir("lumo-proxy-error-"), "proxy.log");
  // Seed with a sentinel line to verify append (not truncate).
  writeFileSync(logFile, `SENTINEL-${port}\n`);

  const { timedOut, exitCode } = await spawnProxyCrash({ port, logFile, throwKind: "exception" });

  assert.ok(!timedOut, "child did not exit within timeout");
  assert.equal(exitCode, 1, "expected exit code 1 after uncaughtException");

  const log = readFileSync(logFile, "utf8");
  assert.ok(log.includes(`fatal: uncaughtException:`), "expected fatal uncaughtException in log");
  assert.ok(log.includes(`test-uncaught-exception-${port}`), "expected error message in log");
  assert.ok(log.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/), "expected ISO timestamp in log");
  assert.ok(log.includes("at "), "expected a stack frame in log");
  assert.ok(log.includes("SENTINEL-" + port), "sentinel survived (append, not truncate)");
});

test("unhandledRejection handler logs synchronously and exits non-zero", async () => {
  const port = 18500 + Math.floor(Math.random() * 500);
  const logFile = join(tempDir("lumo-proxy-error-"), "proxy.log");
  writeFileSync(logFile, `SENTINEL-${port}\n`);

  const { timedOut, exitCode } = await spawnProxyCrash({ port, logFile, throwKind: "rejection" });

  assert.ok(!timedOut, "child did not exit within timeout");
  assert.equal(exitCode, 1, "expected exit code 1 after unhandledRejection");

  const log = readFileSync(logFile, "utf8");
  assert.ok(log.includes(`fatal: unhandledRejection:`), "expected fatal unhandledRejection in log");
  assert.ok(log.includes(`test-unhandled-rejection-${port}`), "expected error message in log");
  assert.ok(log.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/), "expected ISO timestamp in log");
  assert.ok(log.includes("at "), "expected a stack frame in log");
  assert.ok(log.includes("SENTINEL-" + port), "sentinel survived (append, not truncate)");
});
