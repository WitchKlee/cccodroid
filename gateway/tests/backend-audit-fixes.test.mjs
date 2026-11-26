import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { CFG } from "../gw/config.mjs";
import { pdfImageCap } from "../gw/pdf-tools.mjs";
import { zipRead } from "../gw/sessionops.mjs";
import { zipList } from "../gw/zipread.mjs";
import { syncGitSafe } from "../gw/gitsafe.mjs";
import { safeFilePath } from "../gw/files.mjs";
import { UI_KEYS, patchUi, readUi } from "../gw/uistore.mjs";
import { routeUsage } from "../gw/usage.mjs";
import { routeDevside } from "../gw/devside.mjs";
import { routeOffice } from "../gw/office.mjs";

const serveRoute = async (fn, t) => {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    await fn(req, res, u, u.pathname);
    if (!res.writableEnded) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  return (p, init) => fetch(base + p, init);
};

test("pdfImageCap 检查所有页尺寸与页数完整性", () => {
  const small2 = "Page    1 size: 612 x 792 pts\nPage    2 size: 595 x 842 pts\n";
  assert.equal(pdfImageCap(small2, 150, 2), false);
  assert.equal(pdfImageCap(small2, 150, 3), true, "解析页数少于期望页数时应保守封顶");
  const giantPage2 = "Page    1 size: 612 x 792 pts\nPage    2 size: 2000 x 2000 pts\n";
  assert.equal(pdfImageCap(giantPage2, 150, 2), true, "第 2 页超大时必须触发封顶");
  assert.equal(pdfImageCap("Page size: 612 x 792 pts\n", 150), false, "兼容旧 2 参数调用");
});

test("zipRead 拒绝越界偏移与伪造 usize 的 stored 条目", () => {
  // 构造最小 zip：stored 条目实际载荷 32 字节，但中央目录伪造 usize = 0
  const name = Buffer.from("a.txt");
  const body = Buffer.alloc(32, 0x41);
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(0, 8);
  lfh.writeUInt32LE(body.length, 18);
  lfh.writeUInt32LE(0, 22);
  lfh.writeUInt16LE(name.length, 26);
  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(0, 10);
  cdh.writeUInt32LE(body.length, 20);
  cdh.writeUInt32LE(0, 24);
  cdh.writeUInt16LE(name.length, 28);
  cdh.writeUInt32LE(0, 42);
  const cdOff = lfh.length + name.length + body.length;
  const cdLen = cdh.length + name.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdLen, 12);
  eocd.writeUInt32LE(cdOff, 16);
  const spoofed = Buffer.concat([lfh, name, body, cdh, name, eocd]);
  assert.throws(() => zipRead(spoofed, 16), /超过/);

  // 中央目录偏移越界应报 badDir 而非 RangeError
  const badEocd = Buffer.from(eocd);
  badEocd.writeUInt32LE(999999, 16);
  const oob = Buffer.concat([lfh, name, body, cdh, name, badEocd]);
  assert.throws(() => zipRead(oob, 1024), (err) => !(err instanceof RangeError));
});

test("zipList 对截断的 zip64 EOCD 拒绝而非 RangeError", () => {
  const f = path.join(CFG.home, "bad-z64.zip");
  const z64Stub = Buffer.alloc(4);
  z64Stub.writeUInt32LE(0x06064b50, 0);
  const loc = Buffer.alloc(20);
  loc.writeUInt32LE(0x07064b50, 0);
  loc.writeBigUInt64LE(0n, 8); // 总长 46 < 56，读 zip64 EOCD 时不足 56 字节
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0xffff, 10);
  eocd.writeUInt32LE(0xffffffff, 12);
  eocd.writeUInt32LE(0xffffffff, 16);
  fs.writeFileSync(f, Buffer.concat([z64Stub, loc, eocd]));
  assert.throws(() => zipList(f), (err) => !(err instanceof RangeError) && /zip64/.test(err.message));
  fs.rmSync(f, { force: true });
});

test("syncGitSafe 为含注释符路径加双引号并跳过含 * 路径", () => {
  const tmp = fs.mkdtempSync(path.join(CFG.workspace, "gitsafe-"));
  const withHash = path.join(tmp, "proj#1");
  const withStar = path.join(tmp, "bad*dir");
  fs.mkdirSync(withHash);
  syncGitSafe([withHash, withStar]);
  const cfg = fs.readFileSync(path.join(CFG.home, ".gitconfig"), "utf8");
  assert.ok(cfg.includes(`directory = "${withHash}"`), cfg);
  assert.ok(!cfg.includes("bad*dir"), cfg);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("safeFilePath 拒绝工作区内的硬链接（nlink > 1）", () => {
  const tmp = fs.mkdtempSync(path.join(CFG.workspace, "hlink-"));
  const a = path.join(tmp, "a.txt");
  const b = path.join(tmp, "b.txt");
  fs.writeFileSync(a, "secret");
  fs.linkSync(a, b);
  const r = safeFilePath(b);
  assert.equal(r.status, 403);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("uistore 支持极光主题偏好键并原子写入", () => {
  for (const k of ["dshPalette", "dshGlass", "dshAutoFold"]) {
    assert.ok(UI_KEYS.includes(k), `missing ${k}`);
  }
  patchUi({ dshPalette: "ocean", dshGlass: "on", dshAutoFold: "0" });
  const got = readUi();
  assert.equal(got.dshPalette, "ocean");
  assert.equal(got.dshGlass, "on");
  assert.equal(got.dshAutoFold, "0");
  patchUi({ dshPalette: null, dshGlass: null, dshAutoFold: null });
});

test("usage/card 支持 private 私有导出并严格校验 PNG 与文件名", async (t) => {
  const shared = fs.mkdtempSync(path.join(CFG.workspace, "shared-"));
  const prevShared = process.env.CCAPP_SHARED;
  process.env.CCAPP_SHARED = shared;
  t.after(() => {
    if (prevShared === undefined) delete process.env.CCAPP_SHARED; else process.env.CCAPP_SHARED = prevShared;
    fs.rmSync(shared, { recursive: true, force: true });
  });
  const go = await serveRoute(routeUsage, t);
  const validPng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(96, 0x00),
    Buffer.from("IEND"),
    Buffer.alloc(4, 0x00),
  ]).toString("base64");

  // 拒绝前导点与缺 IEND 的伪造 PNG
  assert.equal((await go("/api/usage/card", { method: "POST", body: JSON.stringify({ name: ".hidden.png", data: validPng }) })).status, 400);
  const fakePng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00]), Buffer.alloc(120)]).toString("base64");
  assert.equal((await go("/api/usage/card", { method: "POST", body: JSON.stringify({ name: "fake.png", data: fakePng }) })).status, 400);

  // private: true 强制写入 CFG.home/exports 而非 CCAPP_SHARED/exports
  const r = await go("/api/usage/card", { method: "POST", body: JSON.stringify({ name: "card-priv.png", data: validPng, private: true }) });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.ok(j.file.startsWith(path.join(CFG.home, "exports")), j.file);
  assert.ok(!fs.existsSync(path.join(shared, "exports", "card-priv.png")));
  fs.rmSync(j.file, { force: true });
});

test("devside 与 office 拒绝非法的 HTTP 方法与畸形 JSON", async (t) => {
  const goDev = await serveRoute(routeDevside, t);
  assert.equal((await goDev("/api/app/upd_check", { method: "GET" })).status, 405);
  assert.equal((await goDev("/api/app/upd_check", { method: "POST", body: "{bad" })).status, 400);
  assert.equal((await goDev("/api/mem/clear", { method: "POST", body: "{bad" })).status, 400);

  const goOff = await serveRoute(routeOffice, t);
  assert.equal((await goOff("/api/office/pdf", { method: "PUT", body: "{}" })).status, 405);
  assert.equal((await goOff("/api/office/pdf", { method: "POST", body: "{bad" })).status, 400);
});
