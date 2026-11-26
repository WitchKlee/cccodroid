import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CFG, LIVE, log, noCred, sleep, tz } from "./config.mjs";
import { NEXT, fetchText, readBody, sendJson } from "./http.mjs";
import { loadState, saveState } from "./statefile.mjs";
import { onShutdown } from "./crashguard.mjs";
import { beginBridgeSwitch, bridgeSwitching, killTree, setBridgeUpstream } from "./claude.mjs";
import { PROVIDER, applyProvider, upsertProvider } from "./providers.mjs";
import { SETTINGS, saveSettings } from "./settings-store.mjs";
import { dropModelCache, normalizeModels } from "./models.mjs";
import { RUNS } from "./runs.mjs";
import { clearFollowingModels } from "./projects.mjs";
import { clearFollowingTaskModels } from "./sched.mjs";
import { ghProxy } from "./pget.mjs";
import { zipExtract, zipList, zipNative } from "./zipread.mjs";

// ── 原生内置 Magpie 路由与插件网关 ────────────────────────────────────
// 随 APK 打包官方 yetone/magpie (MIT) 为 lib/arm64-v8a/libccmagpie.so：
//   · 绑定 127.0.0.1:3425（Anthropic / OpenAI 兼容网关）与 127.0.0.1:3430（Web 控制台）
//     —— 严禁绑到 127.0.0.2（宿主 MainActivity 会拦截 127.0.0.2 的非网关端口）。
//   · 在 targetSdk 36 的「经加载器」模式下，把 MAGPIE_BUN 指向 libccrun.so 软链跳板，
//     让纯 Go 的 magpie 调用按需下载的 Android arm64 Bun 运行 WorkBuddy 等社区插件而不触发 W^X EACCES。

export const MAGPIE_VERSION = "0.1.4848";
export const MAGPIE_DEFAULT_GW_PORT = 3425;
export const MAGPIE_DEFAULT_WEB_PORT = 3430;
export const BUN_VERSION = "1.4.2";
export const BUN_ZIP_URL = `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-aarch64-android.zip`;
export const BUN_ZIP_SHA256 = "a1c7e2983f1bb65146beb256a4d72449f23042412bc2cf278aa6397ba27e0274";

const MAGPIE_DIR = path.join(CFG.home, ".cccodroid", "magpie");
const CFG_FILE = path.join(MAGPIE_DIR, "config.json");
const BUN_DIR = path.join(MAGPIE_DIR, "bun");
const BUN_BIN = path.join(BUN_DIR, "bun");
const SHIM_DIR = path.join(MAGPIE_DIR, "shims");
const BUN_SHIM = path.join(SHIM_DIR, "bun");
const LOG_DIR = path.join(CFG.home, ".cache", "cccodroid");
const LOG_FILE = path.join(LOG_DIR, "magpie.log");
const PID_FILE = path.join(LOG_DIR, "magpie.pid");

const LOG_RING_MAX = 80;
const LOG_FILE_MAX = 4 << 20;
const START_TIMEOUT_MS = 15000;

const validPort = (n, fallback) => {
  const v = Number(n);
  return Number.isInteger(v) && v >= 1024 && v <= 65535 ? v : fallback;
};

function cfgShape(j) {
  if (!j || typeof j !== "object" || Array.isArray(j)) return undefined;
  const gatewayPort = validPort(j.gatewayPort, MAGPIE_DEFAULT_GW_PORT);
  let webPort = validPort(j.webPort, MAGPIE_DEFAULT_WEB_PORT);
  if (webPort === gatewayPort) webPort = gatewayPort === MAGPIE_DEFAULT_WEB_PORT ? MAGPIE_DEFAULT_GW_PORT : MAGPIE_DEFAULT_WEB_PORT;
  return { autoStart: !!j.autoStart, gatewayPort, webPort };
}

function loadConfig() {
  return loadState(CFG_FILE, {
    shape: cfgShape,
    fallback: () => ({ autoStart: false, gatewayPort: MAGPIE_DEFAULT_GW_PORT, webPort: MAGPIE_DEFAULT_WEB_PORT }),
  }).data;
}

let mpCfg = loadConfig();

const MP = {
  child: null,
  pid: 0,
  state: "off", // off | starting | running | error
  since: 0,
  err: "",
  webKey: "",
  gatewayPort: mpCfg.gatewayPort,
  webPort: mpCfg.webPort,
};

const BUN_DL = {
  running: false,
  phase: "idle", // idle | downloading | verifying | extracting | done | error
  done: 0,
  total: 0,
  err: "",
};

let startInFlight = null;
let stopRequested = false;
let logRing = [];
let logFileSize = -1;

// 剥除敏感环境变量，防止 magpie 或第三方插件读取 cccodroid 自身的网关令牌与厂商密钥
const STRIP_ENV_KEYS = [
  "CCAPP_KEY_FILE",
  "CCAPP_TOKEN",
  "CCAPP_TOKEN_FILE",
  "CCAPP_SESSION",
  "CCAPP_PROOF_KEY",
  "CCAPP_SIG_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
];

function isExecFile(p) {
  if (!p) return false;
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size <= 0) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

function isRegularNonEmpty(p) {
  if (!p) return false;
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size > 0;
  } catch { return false; }
}

/** 查找内置 magpie 二进制路径（优先 CCAPP_MAGPIE，其次原生库目录，最后 PATH 便于桌面开发调试） */
export function magpieBin() {
  if (process.env.CCAPP_MAGPIE && isExecFile(process.env.CCAPP_MAGPIE)) return process.env.CCAPP_MAGPIE;
  if (process.env.CCAPP_NATIVE_LIB) {
    const p = path.join(process.env.CCAPP_NATIVE_LIB, "libccmagpie.so");
    if (isExecFile(p)) return p;
  }
  const pathDirs = String(process.env.PATH || "").split(":").filter(Boolean);
  for (const d of pathDirs) {
    // 跳过自身的 assets/bin/magpie 包装脚本，避免递归自调用
    const cand = path.join(d, "magpie");
    if (!isExecFile(cand)) continue;
    try {
      const head = fs.readFileSync(cand).subarray(0, 4);
      if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return cand;
    } catch {}
  }
  return "";
}

function enosysBin() {
  if (process.env.CCAPP_ENOSYS_RUN && isExecFile(process.env.CCAPP_ENOSYS_RUN)) return process.env.CCAPP_ENOSYS_RUN;
  if (process.env.CCAPP_NATIVE_LIB) {
    const p = path.join(process.env.CCAPP_NATIVE_LIB, "libccenosysrun.so");
    if (isExecFile(p)) return p;
  }
  return "";
}

export function bunInstalled() {
  return isRegularNonEmpty(BUN_BIN);
}

/** 在 loader 模式下维护 libccrun.so 软链跳板，返回 MAGPIE_BUN 应指向的路径 */
export function ensureBunShim() {
  const loaderMode = process.env.CCAPP_EXEC === "loader";
  const loaderRun = process.env.CCAPP_LOADER_RUN || (process.env.CCAPP_NATIVE_LIB ? path.join(process.env.CCAPP_NATIVE_LIB, "libccrun.so") : "");
  if (loaderMode && loaderRun && fs.existsSync(loaderRun)) {
    try {
      fs.mkdirSync(SHIM_DIR, { recursive: true });
      let cur = "";
      try { cur = fs.readlinkSync(BUN_SHIM); } catch {}
      if (cur !== loaderRun) {
        try { fs.rmSync(BUN_SHIM, { force: true }); } catch {}
        fs.symlinkSync(loaderRun, BUN_SHIM);
      }
      return BUN_SHIM;
    } catch (e) {
      log(`[magpie] 创建 bun 跳板失败：${e.message}`);
    }
  }
  return bunInstalled() ? BUN_BIN : "";
}

function scrubLine(raw) {
  let s = noCred(String(raw || "").replace(/[\r\n]+$/, ""));
  if (MP.webKey && MP.webKey.length >= 8) s = s.split(MP.webKey).join("***");
  if (s.length > 1000) s = s.slice(0, 1000) + " …";
  return s;
}

function appendLog(line) {
  const s = scrubLine(line);
  if (!s) return;
  logRing.push(s);
  if (logRing.length > LOG_RING_MAX) logRing = logRing.slice(-LOG_RING_MAX);
  if (!LIVE) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (logFileSize < 0) logFileSize = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
    if (logFileSize > LOG_FILE_MAX) {
      try { fs.renameSync(LOG_FILE, LOG_FILE + ".1"); } catch {}
      logFileSize = 0;
    }
    fs.appendFileSync(LOG_FILE, s + "\n");
    logFileSize += Buffer.byteLength(s) + 1;
  } catch {}
}

function feedStream(stream) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || "";
    for (const l of lines) appendLog(l);
  });
  stream.on("end", () => {
    if (buf) appendLog(buf);
    buf = "";
  });
}

function cleanStalePid() {
  if (!LIVE) return;
  try {
    const raw = fs.readFileSync(PID_FILE, "utf8").trim();
    const pid = Number(raw);
    if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
      let cmd = "";
      try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch {}
      if (cmd && /magpie|libccmagpie/i.test(cmd)) {
        try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
        log(`[magpie] 已清理上一轮遗留的 magpie 进程 pid=${pid}`);
      }
    }
  } catch {}
  try { fs.rmSync(PID_FILE, { force: true }); } catch {}
}

function buildSpawnEnv(webKey, gwPort) {
  const env = { ...process.env };
  for (const k of STRIP_ENV_KEYS) delete env[k];
  env.HOME = CFG.home;
  env.MAGPIE_ADDR = `127.0.0.1:${gwPort}`;
  env.MAGPIE_WEB_KEY = webKey;
  env.DO_NOT_TRACK = "1";
  env.CCAPP_MAGPIE_BUN_REAL = BUN_BIN;
  const bunPath = ensureBunShim();
  if (bunPath) env.MAGPIE_BUN = bunPath;
  else delete env.MAGPIE_BUN;

  const extraPath = [];
  if (process.env.CCAPP_EXEC === "loader" && process.env.CCAPP_LOADER_BIN) extraPath.push(process.env.CCAPP_LOADER_BIN);
  extraPath.push(BUN_DIR);
  const oldPath = String(env.PATH || "");
  env.PATH = [...extraPath.filter(Boolean), ...(oldPath ? [oldPath] : [])].join(":");
  return env;
}

async function probeUrl(url, timeoutMs = 1200) {
  try {
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    try { await r.body?.cancel(); } catch {}
    return r.status > 0 && r.status < 500;
  } catch { return false; }
}

/** 启动内置 Magpie（含 127.0.0.1:3425 网关与 127.0.0.1:3430 Web 控制台） */
export async function startMagpie() {
  if (MP.child && MP.state === "running") return magpieStatus();
  if (startInFlight) return startInFlight;

  const bin = magpieBin();
  if (!bin) {
    MP.state = "error";
    MP.err = tz("未找到内置 Magpie 程序（libccmagpie.so）");
    return magpieStatus();
  }

  startInFlight = (async () => {
    stopRequested = false;
    cleanStalePid();
    mpCfg = loadConfig();
    const gwPort = mpCfg.gatewayPort;
    const webPort = mpCfg.webPort;
    const webKey = crypto.randomBytes(24).toString("hex");
    MP.gatewayPort = gwPort;
    MP.webPort = webPort;
    MP.webKey = webKey;
    MP.state = "starting";
    MP.err = "";
    MP.since = Date.now();
    logRing = [];

    const env = buildSpawnEnv(webKey, gwPort);
    const enosys = enosysBin();
    const args = ["web", "--addr", `127.0.0.1:${webPort}`, "--no-open"];
    const cmd = enosys ? enosys : bin;
    const argv = enosys ? ["-f", bin, ...args] : args;

    let child;
    try {
      child = spawn(cmd, argv, {
        cwd: CFG.home,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      MP.state = "error";
      MP.err = tz("启动 Magpie 失败：{err}", { err: e.message });
      return magpieStatus();
    }

    MP.child = child;
    MP.pid = child.pid || 0;
    if (LIVE && child.pid) {
      try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.writeFileSync(PID_FILE, String(child.pid) + "\n", { mode: 0o600 }); } catch {}
    }

    let exited = false;
    let exitInfo = "";
    if (child.stdout) feedStream(child.stdout);
    if (child.stderr) feedStream(child.stderr);

    child.on("error", (e) => {
      exited = true;
      exitInfo = e.message || String(e);
      appendLog(`[spawn error] ${exitInfo}`);
      if (MP.child === child) {
        MP.child = null;
        MP.pid = 0;
        MP.state = "error";
        MP.err = tz("Magpie 启动异常：{err}", { err: exitInfo });
      }
    });

    child.on("exit", (code, sig) => {
      exited = true;
      exitInfo = sig ? `signal ${sig}` : `exit ${code}`;
      appendLog(`[exit] ${exitInfo}`);
      if (LIVE) { try { fs.rmSync(PID_FILE, { force: true }); } catch {} }
      if (MP.child === child) {
        MP.child = null;
        MP.pid = 0;
        if (stopRequested) {
          MP.state = "off";
          MP.err = "";
          MP.webKey = "";
        } else {
          MP.state = "error";
          const tail = logRing.length ? logRing[logRing.length - 1] : exitInfo;
          MP.err = tz("Magpie 已退出（{why}）", { why: tail.slice(0, 160) });
        }
      }
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    const webProbe = `http://127.0.0.1:${webPort}/`;
    const gwProbe = `http://127.0.0.1:${gwPort}/v1/models`;
    let ready = false;
    while (Date.now() < deadline && !exited && !stopRequested && MP.child === child) {
      const [webOk, gwOk] = await Promise.all([probeUrl(webProbe), probeUrl(gwProbe)]);
      if (webOk || gwOk) { ready = true; break; }
      await sleep(250);
    }

    if (ready && !exited && !stopRequested && MP.child === child) {
      MP.state = "running";
      MP.err = "";
      log(`[magpie] 已启动 pid=${MP.pid} gw=127.0.0.1:${gwPort} web=127.0.0.1:${webPort}`);
    } else if (!stopRequested && MP.child === child && !exited) {
      MP.state = "error";
      MP.err = tz("Magpie 启动超时，请展开日志查看详情");
      try { killTree(child); } catch {}
    }
    return magpieStatus();
  })().finally(() => { startInFlight = null; });

  return startInFlight;
}

export async function stopMagpie() {
  stopRequested = true;
  const child = MP.child;
  if (!child) {
    MP.state = "off";
    MP.pid = 0;
    MP.err = "";
    MP.webKey = "";
    return magpieStatus();
  }
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const timer = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
      finish();
    }, 3000);
    timer.unref?.();
    child.once("exit", () => { clearTimeout(timer); finish(); });
    try { killTree(child); } catch { finish(); }
  });
  MP.child = null;
  MP.pid = 0;
  MP.state = "off";
  MP.err = "";
  MP.webKey = "";
  if (LIVE) { try { fs.rmSync(PID_FILE, { force: true }); } catch {} }
  log("[magpie] 已停止");
  return magpieStatus();
}

export function stopMagpieSync() {
  stopRequested = true;
  if (MP.child) {
    try { killTree(MP.child); } catch {}
    MP.child = null;
    MP.pid = 0;
    MP.state = "off";
    MP.webKey = "";
  }
  if (LIVE) { try { fs.rmSync(PID_FILE, { force: true }); } catch {} }
}

onShutdown("magpie", stopMagpieSync);

/** 网关启动后按用户配置自动拉起 Magpie（测试模式下不自动拉起） */
export function bootMagpie() {
  if (!LIVE) return;
  mpCfg = loadConfig();
  if (!mpCfg.autoStart || !magpieBin()) return;
  setTimeout(() => {
    startMagpie().catch((e) => log(`[magpie] 自动启动失败：${e.message}`));
  }, 2000).unref();
}

/** 按需下载并校验 Android arm64 Bun 运行时，供 Magpie 社区插件使用 */
export async function installBun(opts = {}) {
  if (BUN_DL.running) return { ok: true, alreadyRunning: true, bun: bunStatus() };
  const url = (!LIVE && opts.url) ? opts.url : BUN_ZIP_URL;
  const wantSha = (!LIVE && opts.sha256) ? String(opts.sha256).toLowerCase() : BUN_ZIP_SHA256;
  const urls = [url];
  const proxied = ghProxy(url);
  if (proxied && proxied !== url) urls.push(proxied);

  BUN_DL.running = true;
  BUN_DL.phase = "downloading";
  BUN_DL.done = 0;
  BUN_DL.total = 0;
  BUN_DL.err = "";

  const tmpZip = path.join(BUN_DIR, `.bun-${process.pid}-${Date.now().toString(36)}.zip`);
  const tmpBin = path.join(BUN_DIR, `.bun-${process.pid}-${Date.now().toString(36)}.bin`);

  try {
    fs.mkdirSync(BUN_DIR, { recursive: true });
    let lastErr = "";
    let downloaded = false;

    for (const cand of urls) {
      try {
        BUN_DL.phase = "downloading";
        BUN_DL.done = 0;
        BUN_DL.total = 0;
        const r = await fetch(cand, { redirect: "follow", signal: AbortSignal.timeout(180000) });
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
        const cl = Number(r.headers.get("content-length") || 0);
        if (cl > 0) BUN_DL.total = cl;

        const hash = crypto.createHash("sha256");
        const ws = fs.createWriteStream(tmpZip, { mode: 0o600 });
        try {
          for await (const chunk of r.body) {
            hash.update(chunk);
            BUN_DL.done += chunk.length;
            if (!ws.write(chunk)) await new Promise((ok, bad) => { ws.once("drain", ok); ws.once("error", bad); });
          }
          await new Promise((ok, bad) => { ws.end(ok); ws.once("error", bad); });
        } catch (e) {
          ws.destroy();
          throw e;
        }

        BUN_DL.phase = "verifying";
        const gotSha = hash.digest("hex").toLowerCase();
        if (gotSha !== wantSha) throw new Error(tz("SHA-256 校验失败（期望 {a}，实际 {b}）", { a: wantSha.slice(0, 12), b: gotSha.slice(0, 12) }));
        downloaded = true;
        break;
      } catch (e) {
        lastErr = e.message || String(e);
        try { fs.rmSync(tmpZip, { force: true }); } catch {}
      }
    }

    if (!downloaded) throw new Error(lastErr || tz("Bun 下载失败"));

    BUN_DL.phase = "extracting";
    const { entries } = zipList(tmpZip);
    const entry = entries.find((e) => zipNative(e) && (e.path === "bun" || e.path.endsWith("/bun")));
    if (!entry) throw new Error(tz("压缩包中未找到 bun 可执行文件"));

    try { fs.rmSync(tmpBin, { force: true }); } catch {}
    await zipExtract(tmpZip, entry, tmpBin);
    fs.chmodSync(tmpBin, 0o755);
    fs.renameSync(tmpBin, BUN_BIN);
    ensureBunShim();

    BUN_DL.phase = "done";
    BUN_DL.err = "";
    log(`[magpie] Bun ${BUN_VERSION} 已就绪 → ${BUN_BIN}`);
    return { ok: true, bun: bunStatus() };
  } catch (e) {
    BUN_DL.phase = "error";
    BUN_DL.err = e.message || String(e);
    log(`[magpie] 安装 Bun 失败：${BUN_DL.err}`);
    return { ok: false, error: BUN_DL.err, bun: bunStatus() };
  } finally {
    BUN_DL.running = false;
    try { fs.rmSync(tmpZip, { force: true }); } catch {}
    try { fs.rmSync(tmpBin, { force: true }); } catch {}
  }
}

export function bunStatus() {
  return {
    installed: bunInstalled(),
    version: BUN_VERSION,
    bin: BUN_BIN,
    shim: process.env.CCAPP_EXEC === "loader" ? BUN_SHIM : "",
    downloading: BUN_DL.running,
    phase: BUN_DL.phase,
    done: BUN_DL.done,
    total: BUN_DL.total,
    err: BUN_DL.err,
  };
}

export function magpieStatus() {
  const bin = magpieBin();
  const running = MP.state === "running" && !!MP.child;
  const gatewayUrl = `http://127.0.0.1:${MP.gatewayPort}`;
  const webUrl = running && MP.webKey ? `http://127.0.0.1:${MP.webPort}/?k=${MP.webKey}` : "";
  return {
    available: !!bin,
    version: MAGPIE_VERSION,
    bin,
    execMode: process.env.CCAPP_EXEC || "direct",
    state: MP.state,
    running,
    pid: MP.pid,
    since: MP.since,
    err: MP.err,
    gatewayPort: MP.gatewayPort,
    webPort: MP.webPort,
    gatewayUrl,
    webUrl,
    autoStart: !!mpCfg.autoStart,
    connected: PROVIDER.id === "magpie",
    bun: bunStatus(),
    logs: logRing.slice(-LOG_RING_MAX),
  };
}

/** 一键接入 Magpie：必要时拉起服务、拉取实时模型列表，并将 cccodroid 切换到 magpie 厂商 */
export async function connectMagpie() {
  if (PROVIDER.id !== "magpie" && (RUNS.size || bridgeSwitching())) {
    return {
      status: 409,
      body: { error: "busy", message: tz("这一轮还在生成中，等它跑完再切换到 Magpie。") },
    };
  }

  let st = magpieStatus();
  if (!st.running) st = await startMagpie();
  if (!st.running) {
    return {
      status: 500,
      body: { error: "start_failed", message: st.err || tz("Magpie 未能启动"), status: st },
    };
  }

  let models = [];
  try {
    const r = await fetch(`${st.gatewayUrl}/v1/models`, {
      headers: { Authorization: "Bearer magpie-local" },
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      const j = JSON.parse(await fetchText(r, 2 << 20));
      models = normalizeModels(j);
    }
  } catch {}

  const firstModel = models.length ? models[0].id : "";
  const up = upsertProvider("magpie", {
    apiKey: "magpie-local",
    ...(firstModel ? { defaultModel: firstModel } : {}),
  });
  if (up.error) {
    return { status: up.status || 400, body: { error: up.error, message: up.message || up.error } };
  }

  if (PROVIDER.id !== "magpie") {
    const switched = beginBridgeSwitch();
    try {
      SETTINGS.provider = "magpie";
      SETTINGS.model = firstModel || null;
      SETTINGS.titleModel = null;
      clearFollowingModels();
      clearFollowingTaskModels();
      applyProvider();
      await setBridgeUpstream(CFG.upstream);
    } finally {
      switched();
    }
    saveSettings();
  } else if (firstModel && !SETTINGS.model) {
    SETTINGS.model = firstModel;
    saveSettings();
  }
  dropModelCache();

  return {
    status: 200,
    body: {
      ok: true,
      provider: PROVIDER.id,
      modelCount: models.length,
      models: models.slice(0, 100),
      status: magpieStatus(),
    },
  };
}

function parseJsonBody(raw) {
  if (!raw || !raw.trim()) return { ok: true, data: {} };
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object" || Array.isArray(j)) return { ok: false };
    return { ok: true, data: j };
  } catch {
    return { ok: false };
  }
}

export async function routeMagpie(req, res, u, p) {
  if (!p.startsWith("/api/magpie")) return NEXT;

  if (req.method === "GET" && p === "/api/magpie/status") {
    return sendJson(res, 200, magpieStatus());
  }

  if (req.method === "POST" && p === "/api/magpie/start") {
    const st = await startMagpie();
    return sendJson(res, st.running ? 200 : (st.available ? 500 : 404), st);
  }

  if (req.method === "POST" && p === "/api/magpie/stop") {
    const st = await stopMagpie();
    return sendJson(res, 200, st);
  }

  if (req.method === "POST" && p === "/api/magpie/config") {
    const parsed = parseJsonBody(await readBody(req, 16 << 10));
    if (!parsed.ok) return sendJson(res, 400, { error: "invalid json" });
    const b = parsed.data;
    const next = { ...mpCfg };
    if ("autoStart" in b) next.autoStart = !!b.autoStart;
    if ("gatewayPort" in b) next.gatewayPort = validPort(b.gatewayPort, next.gatewayPort);
    if ("webPort" in b) next.webPort = validPort(b.webPort, next.webPort);
    if (next.gatewayPort === next.webPort) return sendJson(res, 400, { error: "ports must differ" });
    if (!saveState(CFG_FILE, next, { mode: 0o600 })) {
      return sendJson(res, 500, { error: tz("保存 Magpie 配置失败") });
    }
    mpCfg = next;
    if (!MP.child) { MP.gatewayPort = next.gatewayPort; MP.webPort = next.webPort; }
    return sendJson(res, 200, { ok: true, status: magpieStatus() });
  }

  if (req.method === "POST" && p === "/api/magpie/bun/install") {
    const parsed = parseJsonBody(await readBody(req, 16 << 10));
    if (!parsed.ok) return sendJson(res, 400, { error: "invalid json" });
    const b = parsed.data;
    if (u.searchParams.get("sync") === "1" || b.sync === true) {
      const r = await installBun();
      return sendJson(res, r.ok ? 200 : 500, r);
    }
    if (!BUN_DL.running) {
      installBun().catch(() => {});
    }
    return sendJson(res, 202, { ok: true, bun: bunStatus() });
  }

  if (req.method === "POST" && p === "/api/magpie/connect") {
    const r = await connectMagpie();
    return sendJson(res, r.status, r.body);
  }

  return NEXT;
}

export const _magpieForTest = {
  MAGPIE_DIR,
  CFG_FILE,
  BUN_DIR,
  BUN_BIN,
  SHIM_DIR,
  BUN_SHIM,
  loadConfig,
  reloadConfig: () => { mpCfg = loadConfig(); MP.gatewayPort = mpCfg.gatewayPort; MP.webPort = mpCfg.webPort; return mpCfg; },
  installBun,
};
