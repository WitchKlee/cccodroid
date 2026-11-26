import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import zlib from "node:zlib";
import { CFG } from "../gw/config.mjs";
import { PROVIDER } from "../gw/providers.mjs";
import { SETTINGS } from "../gw/settings-store.mjs";
import {
  _magpieForTest,
  bunInstalled,
  ensureBunShim,
  magpieStatus,
  routeMagpie,
  stopMagpie,
} from "../gw/magpie.mjs";

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

async function callRoute(method, urlPath, body) {
  const raw = body == null ? "" : (typeof body === "string" ? body : JSON.stringify(body));
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.url = urlPath;
  req.headers = { host: "127.0.0.1:8790", "content-type": "application/json" };

  let status = 0;
  let headers = {};
  let data = "";
  const res = {
    headersSent: false,
    writeHead(code, h = {}) { status = code; headers = h; this.headersSent = true; },
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    end(chunk = "") { data += chunk ? String(chunk) : ""; },
  };
  const u = new URL(urlPath, "http://127.0.0.1:8790");
  await routeMagpie(req, res, u, u.pathname);
  return { status, headers, body: data ? JSON.parse(data) : null };
}

/** 构造一个合法的最小 zip（stored 方法），用于测试 Bun 压缩包校验与流式解压 */
function makeZip(name, contentBuf) {
  const nameBuf = Buffer.from(name, "utf8");
  const crc = zlib.crc32(contentBuf) >>> 0;
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(0, 6);
  lfh.writeUInt16LE(0, 8);
  lfh.writeUInt32LE(crc, 14);
  lfh.writeUInt32LE(contentBuf.length, 18);
  lfh.writeUInt32LE(contentBuf.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  lfh.writeUInt16LE(0, 28);

  const cdOff = lfh.length + nameBuf.length + contentBuf.length;
  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(0x0314, 4);
  cdh.writeUInt16LE(20, 6);
  cdh.writeUInt16LE(0, 8);
  cdh.writeUInt16LE(0, 10);
  cdh.writeUInt32LE(crc, 16);
  cdh.writeUInt32LE(contentBuf.length, 20);
  cdh.writeUInt32LE(contentBuf.length, 24);
  cdh.writeUInt16LE(nameBuf.length, 28);
  cdh.writeUInt32LE((0o100755 << 16) >>> 0, 38);
  cdh.writeUInt32LE(0, 42);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdh.length + nameBuf.length, 12);
  eocd.writeUInt32LE(cdOff, 16);

  return Buffer.concat([lfh, nameBuf, contentBuf, cdh, nameBuf, eocd]);
}

test("magpie config persistence and validation", async () => {
  const badJson = await callRoute("POST", "/api/magpie/config", "{broken");
  assert.equal(badJson.status, 400);

  const samePort = await callRoute("POST", "/api/magpie/config", { gatewayPort: 3425, webPort: 3425 });
  assert.equal(samePort.status, 400);

  const ok = await callRoute("POST", "/api/magpie/config", { autoStart: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.status.autoStart, true);

  const disk = JSON.parse(fs.readFileSync(_magpieForTest.CFG_FILE, "utf8"));
  assert.equal(disk.autoStart, true);

  // 恢复默认
  await callRoute("POST", "/api/magpie/config", { autoStart: false });
});

test("loader mode creates W^X-safe libccrun.so symlink shim for MAGPIE_BUN", () => {
  const prevExec = process.env.CCAPP_EXEC;
  const prevRun = process.env.CCAPP_LOADER_RUN;
  const fakeRun = path.join(CFG.home, "fake-libccrun.so");
  fs.writeFileSync(fakeRun, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  try {
    process.env.CCAPP_EXEC = "loader";
    process.env.CCAPP_LOADER_RUN = fakeRun;
    const shim = ensureBunShim();
    assert.equal(shim, _magpieForTest.BUN_SHIM);
    assert.equal(fs.readlinkSync(_magpieForTest.BUN_SHIM), fakeRun);
  } finally {
    if (prevExec === undefined) delete process.env.CCAPP_EXEC; else process.env.CCAPP_EXEC = prevExec;
    if (prevRun === undefined) delete process.env.CCAPP_LOADER_RUN; else process.env.CCAPP_LOADER_RUN = prevRun;
  }
});

test("magpie start, secret stripping, log redaction, connect, and stop", async () => {
  const gwPort = await freePort();
  const webPort = await freePort();
  const fakeBin = path.join(CFG.home, "fake-magpie.mjs");
  fs.writeFileSync(fakeBin, `#!${process.execPath}
import http from "node:http";
const addr = process.env.MAGPIE_ADDR || "127.0.0.1:3425";
const gwPort = Number(addr.split(":")[1]);
const webIdx = process.argv.indexOf("--addr");
const webPort = Number(process.argv[webIdx + 1].split(":")[1]);
console.log("webkey_leak_check=" + (process.env.MAGPIE_WEB_KEY || ""));
console.log("secret_check=" + (process.env.ANTHROPIC_API_KEY ? "LEAKED" : "CLEAN") + ":" + (process.env.CCAPP_TOKEN ? "LEAKED" : "CLEAN"));
const gw = http.createServer((req, res) => {
  if (req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: [{ id: "workbuddy/deepseek-v3", object: "model" }] }));
  }
  res.writeHead(404); res.end();
});
const web = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html><body>magpie</body></html>");
});
gw.listen(gwPort, "127.0.0.1");
web.listen(webPort, "127.0.0.1");
process.on("SIGTERM", () => { gw.close(); web.close(); process.exit(0); });
`, { mode: 0o755 });

  const prevBin = process.env.CCAPP_MAGPIE;
  const prevEnosys = process.env.CCAPP_ENOSYS_RUN;
  const prevNative = process.env.CCAPP_NATIVE_LIB;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevTok = process.env.CCAPP_TOKEN;
  try {
    process.env.CCAPP_MAGPIE = fakeBin;
    delete process.env.CCAPP_ENOSYS_RUN;
    delete process.env.CCAPP_NATIVE_LIB;
    process.env.ANTHROPIC_API_KEY = "sk-ant-secret-must-not-leak-12345678";
    process.env.CCAPP_TOKEN = "tok-secret-must-not-leak";

    await callRoute("POST", "/api/magpie/config", { gatewayPort: gwPort, webPort });

    const started = await callRoute("POST", "/api/magpie/start", {});
    assert.equal(started.status, 200);
    assert.equal(started.body.running, true);
    assert.match(started.body.webUrl, new RegExp(`^http://127\\.0\\.0\\.1:${webPort}/\\?k=[0-9a-f]{48}$`));
    const key = new URL(started.body.webUrl).searchParams.get("k");
    assert.ok(key && key.length === 48);

    const logsText = started.body.logs.join("\n");
    assert.match(logsText, /secret_check=CLEAN:CLEAN/);
    assert.ok(!logsText.includes(key), "MAGPIE_WEB_KEY must be scrubbed from logs");

    const conn = await callRoute("POST", "/api/magpie/connect", {});
    assert.equal(conn.status, 200);
    assert.equal(conn.body.ok, true);
    assert.equal(conn.body.provider, "magpie");
    assert.equal(conn.body.modelCount, 1);
    assert.equal(conn.body.models[0].id, "workbuddy/deepseek-v3");
    assert.equal(PROVIDER.id, "magpie");
    assert.equal(SETTINGS.provider, "magpie");

    const stopped = await callRoute("POST", "/api/magpie/stop", {});
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.running, false);
    assert.equal(stopped.body.webUrl, "");
  } finally {
    await stopMagpie();
    if (prevBin === undefined) delete process.env.CCAPP_MAGPIE; else process.env.CCAPP_MAGPIE = prevBin;
    if (prevEnosys === undefined) delete process.env.CCAPP_ENOSYS_RUN; else process.env.CCAPP_ENOSYS_RUN = prevEnosys;
    if (prevNative === undefined) delete process.env.CCAPP_NATIVE_LIB; else process.env.CCAPP_NATIVE_LIB = prevNative;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevTok === undefined) delete process.env.CCAPP_TOKEN; else process.env.CCAPP_TOKEN = prevTok;
  }
});

test("bun installer verifies SHA-256 and extracts bun executable from zip", async () => {
  const payload = Buffer.from("#!/bin/sh\necho bun-ok\n", "utf8");
  const zipBuf = makeZip("bun-linux-aarch64-android/bun", payload);
  const sha = crypto.createHash("sha256").update(zipBuf).digest("hex");

  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/zip", "content-length": String(zipBuf.length) });
    res.end(zipBuf);
  });
  const port = await new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv.address().port)));
  try {
    // 错误 SHA-256 必须拒收
    const bad = await _magpieForTest.installBun({ url: `http://127.0.0.1:${port}/bun.zip`, sha256: "0".repeat(64) });
    assert.equal(bad.ok, false);
    assert.equal(bunInstalled(), false);

    // 正确 SHA-256 必须解压并赋予可执行权限
    const good = await _magpieForTest.installBun({ url: `http://127.0.0.1:${port}/bun.zip`, sha256: sha });
    assert.equal(good.ok, true);
    assert.equal(bunInstalled(), true);
    assert.deepEqual(fs.readFileSync(_magpieForTest.BUN_BIN), payload);
    const mode = fs.statSync(_magpieForTest.BUN_BIN).mode & 0o777;
    assert.equal(mode & 0o111, 0o111);
    assert.equal(magpieStatus().bun.installed, true);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});
