  // ── 极光琉璃（DSH UI）：自动折叠过程卡 / 右侧快捷抽屉与双侧手势 / 对话分享卡 ──
  const DSH_FOLD_LS = "cc.dsh.autoFold";
  let dshAutoFold = true;
  try {
    const savedFold = typeof uiGet === "function" ? uiGet("dshAutoFold", DSH_FOLD_LS) : localStorage.getItem(DSH_FOLD_LS);
    dshAutoFold = savedFold !== "0";
  } catch {}

  function dshSetAutoFold(on, sync = true) {
    dshAutoFold = !!on;
    try { localStorage.setItem(DSH_FOLD_LS, dshAutoFold ? "1" : "0"); } catch {}
    if (sync && typeof uiSet === "function") uiSet("dshAutoFold", dshAutoFold ? "1" : "0");
    const sw = $("dsh-sw-fold");
    if (sw && sw.checked !== dshAutoFold) sw.checked = dshAutoFold;
  }

  /** 回答完成时按偏好自动收起思考块与工具过程卡（出错 / 含待确认权限 / 含工具预览图的不收） */
  function dshOnTurnFinish(msgEl, aborted, failed) {
    if (!dshAutoFold || aborted || failed || !msgEl) return;
    msgEl.querySelectorAll("details.think[open]").forEach((d) => { d.open = false; });
    msgEl.querySelectorAll(".tgroup").forEach((tg) => {
      if (tg.querySelector(".perm:not(.done), .tool-peek, .tool-state.err, .tool-state.run")) return;
      if (!tg.classList.contains("single") && tg.classList.contains("open")) {
        tg.classList.remove("open");
        tg.classList.add("shut");
      }
      tg.querySelectorAll(".tool.open, .tool-sub.open").forEach((x) => x.classList.remove("open"));
    });
  }

  // ── 极光六色板同步渲染（设置页 #dsh-pal-sw 与右侧抽屉 #dsh-rpal 共用） ──
  const DSH_SKIN_NAMES = { dsh: tk("极光"), native: tk("原生"), qiusuo: tk("求索"), zhuyue: tk("逐月"), goucheng: tk("构成"), shise: tk("拾色") };
  function renderDshPalettes() {
    if (!window.Theme || !Theme.dshPalettes) return;
    const pals = Theme.dshPalettes, cur = Theme.dshPalette, skin = Theme.skin, mode = Theme.current || "light";
    const html = pals.map((p) => {
      const dot = Theme.accentFor ? Theme.accentFor(p.seed, "dsh", mode).acc : p.seed;
      const on = skin === "dsh" && cur === p.id;
      return `<button type="button" class="dsh-pal-btn${on ? " on" : ""}" data-pal="${esc(p.id)}" aria-pressed="${on}">`
        + `<span class="dsh-pal-dot" style="background:${dot}"></span>`
        + `<span class="dsh-pal-name">${esc(t(p.name))}</span></button>`;
    }).join("");
    for (const id of ["dsh-pal-sw", "dsh-rpal"]) {
      const el = $(id);
      if (el && el.innerHTML !== html) el.innerHTML = html;
    }
    const rmode = $("dsh-rmode");
    if (rmode) {
      const m = Theme.mode || "auto";
      rmode.querySelectorAll("[data-md]").forEach((b) => {
        const on = b.dataset.md === m;
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", String(on));
      });
    }
    const stag = $("dsh-rskin-tag");
    if (stag) stag.textContent = t(DSH_SKIN_NAMES[skin] || skin);
    const swG = $("dsh-sw-glass");
    if (swG) swG.checked = !!Theme.glass;
    const swF = $("dsh-sw-fold");
    if (swF) swF.checked = dshAutoFold;
  }

  function pickDshPalette(id) {
    if (!window.Theme || !Theme.setDshPalette) return;
    if (uiGet("accent")) uiSet("accent", null);
    Theme.setDshPalette(id);
    if (typeof uiSet === "function") uiSet("dshPalette", id);
    renderDshPalettes();
  }

  function dshApplyUiKey(key) {
    if (typeof uiGet !== "function") return;
    if (key === "dshPalette") {
      const v = uiGet("dshPalette");
      if (v && window.Theme && Theme.setDshPalette && Theme.dshPalette !== v) Theme.setDshPalette(v);
    } else if (key === "dshGlass") {
      const v = uiGet("dshGlass");
      if ((v === "on" || v === "off") && window.Theme && Theme.setGlass && Theme.glass !== (v === "on")) Theme.setGlass(v === "on");
    } else if (key === "dshAutoFold") {
      const v = uiGet("dshAutoFold");
      if (v === "0" || v === "1") dshSetAutoFold(v !== "0", false);
    }
  }

  for (const id of ["dsh-pal-sw", "dsh-rpal"]) {
    $(id)?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-pal]");
      if (b) pickDshPalette(b.dataset.pal);
    });
  }
  $("dsh-rmode")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-md]");
    if (!b || !window.Theme) return;
    const pfx = { dsh: "dsh-", native: "", qiusuo: "qs-", zhuyue: "zy-", goucheng: "gc-", shise: "ss-" }[Theme.skin] || "dsh-";
    Theme.set(pfx + b.dataset.md);
    renderDshPalettes();
  });
  $("dsh-sw-glass")?.addEventListener("change", (e) => {
    if (window.Theme && Theme.setGlass) Theme.setGlass(e.target.checked);
    if (typeof uiSet === "function") uiSet("dshGlass", e.target.checked ? "on" : "off");
  });
  $("dsh-sw-fold")?.addEventListener("change", (e) => dshSetAutoFold(e.target.checked, true));
  document.addEventListener("cc:ui", (e) => dshApplyUiKey(e.detail && e.detail.key));
  document.addEventListener("cc:dsh", renderDshPalettes);
  new MutationObserver(renderDshPalettes).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-skin", "data-glass", "data-dsh-pal"] });
  dshApplyUiKey("dshPalette");
  dshApplyUiKey("dshGlass");
  renderDshPalettes();

  // ── 右侧快捷面板抽屉（顶栏按钮 + 主区域左滑展开 / 抽屉右滑收起） ──
  const rdrawerEl = $("dsh-rdrawer");
  const rpanelEl = rdrawerEl ? rdrawerEl.querySelector(".dsh-rpanel") : null;

  function dshSyncRightDrawer() {
    if (!rdrawerEl) return;
    const title = view.title || $("app-title")?.textContent || "cccodroid";
    const rs = $("dsh-rsess"); if (rs) rs.textContent = title;
    const st = $("dsh-rstat"); if (st) st.textContent = $("stat-chip")?.textContent || "";
    const mt = $("dsh-rmodel-t");
    if (mt) {
      const chips = [...($("model-chip")?.querySelectorAll(".chip") || [])].map((x) => x.textContent.trim()).filter(Boolean);
      mt.textContent = chips.length ? chips.join(" · ") : ($("model-chip")?.textContent || "—");
    }
    const pt = $("dsh-rperm-t"); if (pt) pt.textContent = $("perm-chip")?.textContent || t("默认权限");
    const fill = $("ctxfill")?.style.width || "0%";
    const rf = $("dsh-rctx-fill"); if (rf) rf.style.width = fill;
    const rr = $("dsh-rctx-r");
    if (rr) {
      const txt = [$("ctxctx")?.textContent, $("ctxq")?.textContent].map((s) => (s || "").trim()).filter(Boolean).join(" · ");
      rr.textContent = txt || t("就绪");
    }
    renderDshPalettes();
  }

  function dshOpenRightDrawer(fromGesture) {
    if (!rdrawerEl) return;
    dshSyncRightDrawer();
    if (!fromGesture && rpanelEl) {
      rpanelEl.style.animation = "";
      rpanelEl.style.transition = "";
      rpanelEl.style.transform = "";
      rdrawerEl.style.transition = "";
      rdrawerEl.style.background = "";
      rdrawerEl.style.backdropFilter = "";
    }
    rdrawerEl.classList.remove("hidden");
  }

  function dshCloseRightDrawer() {
    if (!rdrawerEl || rdrawerEl.classList.contains("hidden")) return;
    rdrawerEl.classList.add("hidden");
    if (rpanelEl) {
      rpanelEl.style.animation = "";
      rpanelEl.style.transition = "";
      rpanelEl.style.transform = "";
    }
    rdrawerEl.style.transition = "";
    rdrawerEl.style.background = "";
    rdrawerEl.style.backdropFilter = "";
  }

  $("btn-dsh-panel")?.addEventListener("click", () => {
    if (rdrawerEl && !rdrawerEl.classList.contains("hidden")) dshCloseRightDrawer();
    else dshOpenRightDrawer(false);
  });
  $("btn-close-rdrawer")?.addEventListener("click", dshCloseRightDrawer);
  rdrawerEl?.addEventListener("click", (e) => { if (e.target === rdrawerEl) dshCloseRightDrawer(); });
  $("dsh-rmodel")?.addEventListener("click", () => { dshCloseRightDrawer(); openModelPicker(); });
  $("dsh-rperm")?.addEventListener("click", () => { dshCloseRightDrawer(); $("perm-chip")?.click(); });
  rdrawerEl?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-dsh-act]");
    if (!b) return;
    const act = b.dataset.dshAct;
    dshCloseRightDrawer();
    if (act === "files") openFiles();
    else if (act === "term") openTerm();
    else if (act === "git") openGit();
    else if (act === "card") openShareCardLatest();
  });

  // 右侧抽屉双向跟手滑动（左滑呼出、右滑关闭；尊重横向代码块/表格与系统边缘返回手势）
  (() => {
    if (!rdrawerEl || !rpanelEl) return;
    const rtl = () => document.documentElement.dir === "rtl";
    const hScrollableLeft = (el) => {
      for (; el && el !== document.body; el = el.parentElement) {
        if (el.scrollWidth > el.clientWidth + 2 && /auto|scroll/.test(getComputedStyle(el).overflowX)) {
          const canScrollMore = rtl() ? el.scrollLeft > -(el.scrollWidth - el.clientWidth) + 1 : el.scrollLeft < el.scrollWidth - el.clientWidth - 1;
          if (canScrollMore) return true;
        }
      }
      return false;
    };
    const scrim = (k) => {
      rdrawerEl.style.background = `color-mix(in srgb, var(--scrim) ${Math.round(k * 100)}%, transparent)`;
      rdrawerEl.style.backdropFilter = k >= 1 ? "" : `blur(${(3 * k).toFixed(2)}px)`;
    };
    const reset = () => {
      rpanelEl.style.transition = ""; rpanelEl.style.transform = "";
      rdrawerEl.style.transition = ""; rdrawerEl.style.background = ""; rdrawerEl.style.backdropFilter = "";
    };

    let g = null;
    const zones = [chatEl, $("composer"), $("wl-below")].filter(Boolean);
    const onStart = (e) => {
      g = null;
      if (e.touches.length !== 1 || !rdrawerEl.classList.contains("hidden") || !drawerEl.classList.contains("hidden") && !(window.CCLayout && CCLayout.docked())) return;
      if (!$("pages").classList.contains("hidden") || OV.top() || document.querySelector("#sheet:not(.hidden), #popup:not(.hidden)")) return;
      if (e.target.closest("textarea,input,select,.xterm") || e.target.closest("#composer button,#composer .att,#composer .chip,#composer [role=button]")
        || String(getSelection() || "").length || hScrollableLeft(e.target)) return;
      const p = e.touches[0];
      // 避开屏幕最右侧 20px 系统侧滑返回热区
      if (!rtl() && p.clientX > innerWidth - 20) return;
      if (rtl() && p.clientX < 20) return;
      g = { x: p.clientX, y: p.clientY, on: false, w: 0, dx: 0, lastX: p.clientX, lastT: performance.now(), v: 0 };
    };
    const onMove = (e) => {
      if (!g || e.touches.length !== 1) { g = null; return; }
      const p = e.touches[0], dx = (g.x - p.clientX) * (rtl() ? -1 : 1), dy = p.clientY - g.y;
      if (!g.on) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        if (!(dx > 0 && dx >= Math.abs(dy) * 1.15)) { g = null; return; }
        g.on = true;
        rpanelEl.style.animation = "none";
        rpanelEl.style.transition = rdrawerEl.style.transition = "none";
        rpanelEl.style.transform = rtl() ? "translateX(-100%)" : "translateX(100%)";
        scrim(0);
        dshOpenRightDrawer(true);
        g.w = rpanelEl.getBoundingClientRect().width || 320;
      }
      if (e.cancelable) e.preventDefault();
      const now = performance.now();
      g.v = ((g.lastX - p.clientX) * (rtl() ? -1 : 1)) / Math.max(1, now - g.lastT);
      g.lastX = p.clientX; g.lastT = now;
      g.dx = Math.max(0, Math.min(g.w, dx - 10));
      const k = g.dx / g.w;
      rpanelEl.style.transform = `translateX(${(rtl() ? -1 : 1) * (g.w - g.dx)}px)`;
      scrim(k);
    };
    const onEnd = () => {
      const s = g; g = null;
      if (!s || !s.on) return;
      const open = s.dx > s.w / 4 || s.v > 0.32;
      rdrawerEl.style.transition = "background-color .18s ease";
      rpanelEl.style.transition = "transform .2s cubic-bezier(.22,1,.36,1)";
      rpanelEl.style.transform = open ? "translateX(0)" : `translateX(${(rtl() ? -1 : 1) * s.w}px)`;
      scrim(open ? 0.999 : 0);
      setTimeout(() => { if (open) reset(); else dshCloseRightDrawer(); }, 210);
    };
    for (const z of zones) {
      z.addEventListener("touchstart", onStart, { passive: true });
      z.addEventListener("touchmove", onMove, { passive: false });
      z.addEventListener("touchend", onEnd, { passive: true });
      z.addEventListener("touchcancel", onEnd, { passive: true });
    }

    // 在右侧抽屉上往右推收起
    let c = null;
    rdrawerEl.addEventListener("touchstart", (e) => {
      c = null;
      if (e.touches.length !== 1 || rdrawerEl.classList.contains("hidden") || OV.top()) return;
      if (e.target.closest("input,select,textarea")) return;
      const p = e.touches[0];
      c = { x: p.clientX, y: p.clientY, on: false, w: 0, dx: 0, lastX: p.clientX, lastT: performance.now(), v: 0 };
    }, { passive: true });
    rdrawerEl.addEventListener("touchmove", (e) => {
      if (!c || e.touches.length !== 1) { c = null; return; }
      const p = e.touches[0], dx = (p.clientX - c.x) * (rtl() ? -1 : 1), dy = p.clientY - c.y;
      if (!c.on) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (!(dx > 0 && dx >= Math.abs(dy))) { c = null; return; }
        c.on = true;
        c.w = rpanelEl.getBoundingClientRect().width || 320;
        rpanelEl.style.animation = "none";
        rpanelEl.style.transition = rdrawerEl.style.transition = "none";
      }
      if (e.cancelable) e.preventDefault();
      const now = performance.now();
      c.v = ((p.clientX - c.lastX) * (rtl() ? -1 : 1)) / Math.max(1, now - c.lastT);
      c.lastX = p.clientX; c.lastT = now;
      c.dx = Math.max(0, Math.min(c.w, dx - 8));
      rpanelEl.style.transform = `translateX(${(rtl() ? -1 : 1) * c.dx}px)`;
      scrim(1 - c.dx / c.w);
    }, { passive: false });
    const endClose = () => {
      const s = c; c = null;
      if (!s || !s.on) return;
      const shut = s.dx > s.w / 5 || s.v > 0.3;
      rdrawerEl.style.transition = "background-color .18s ease";
      rpanelEl.style.transition = "transform .18s ease";
      rpanelEl.style.transform = shut ? `translateX(${(rtl() ? -1 : 1) * s.w}px)` : "translateX(0)";
      scrim(shut ? 0 : 0.999);
      setTimeout(() => { if (shut) dshCloseRightDrawer(); else reset(); }, 190);
    };
    rdrawerEl.addEventListener("touchend", endClose, { passive: true });
    rdrawerEl.addEventListener("touchcancel", endClose, { passive: true });
  })();

  // ── 对话分享卡（纯 Canvas 2D 高清渲染，零外链依赖，原生保存与系统分享） ──
  function findPrevQuestion(botMsgEl) {
    const msgs = [...chatEl.querySelectorAll(".msg")];
    const idx = msgs.indexOf(botMsgEl);
    for (let i = idx - 1; i >= 0; i--) {
      if (msgs[i].classList.contains("user")) {
        const raw = userTextOf.get(msgs[i]) || msgs[i].querySelector(".bubble")?.textContent || "";
        const [body] = typeof splitRefs === "function" ? splitRefs(raw) : [raw];
        return (body || "").trim();
      }
    }
    return "";
  }

  function openShareCardLatest() {
    const bots = [...chatEl.querySelectorAll(".msg.bot")].reverse();
    for (const m of bots) {
      const parts = [...m.querySelectorAll(".bubble .txt")].map((el) => (el._src ? el._src() : el.textContent || "").trim()).filter(Boolean);
      const txt = parts.join("\n\n").trim();
      if (txt) return openShareCard(m, txt);
    }
    toast(t("当前会话还没有可分享的回复"), true);
  }

  function dshRoundRect(g, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + rr, y);
    g.arcTo(x + w, y, x + w, y + h, rr);
    g.arcTo(x + w, y + h, x, y + h, rr);
    g.arcTo(x, y + h, x, y, rr);
    g.arcTo(x, y, x + w, y, rr);
    g.closePath();
  }

  function dshWrapText(g, text, maxW) {
    const out = [];
    for (const rawLine of String(text || "").split("\n")) {
      if (!rawLine) { out.push(""); continue; }
      let cur = "";
      for (const ch of Array.from(rawLine)) {
        const next = cur + ch;
        if (cur && g.measureText(next).width > maxW) {
          // 英文单词尽量在空格处断行
          const sp = cur.lastIndexOf(" ");
          if (sp > 4 && /[A-Za-z0-9]/.test(ch)) {
            out.push(cur.slice(0, sp));
            cur = cur.slice(sp + 1) + ch;
          } else {
            out.push(cur);
            cur = ch;
          }
        } else cur = next;
      }
      if (cur) out.push(cur);
    }
    return out;
  }

  function dshParseCardBlocks(md) {
    const blocks = [], lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
    let i = 0;
    const cleanInline = (s) => s
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "[$1]")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .trim();
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*```/.test(l)) {
        const lang = l.replace(/^\s*```/, "").trim();
        const code = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
        if (i < lines.length) i++;
        blocks.push({ type: "code", lang, text: code.join("\n") });
        continue;
      }
      if (!l.trim()) { i++; continue; }
      const hm = l.match(/^\s*(#{1,3})\s+(.+)$/);
      if (hm) { blocks.push({ type: "h", level: hm[1].length, text: cleanInline(hm[2]) }); i++; continue; }
      if (/^\s*>\s?/.test(l)) {
        const q = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(cleanInline(lines[i].replace(/^\s*>\s?/, ""))); i++; }
        blocks.push({ type: "quote", text: q.join("\n") });
        continue;
      }
      const lm = l.match(/^\s*(?:[-*+]|\d+\.)\s+(.+)$/);
      if (lm) {
        const bullet = /^\s*\d+\./.test(l) ? l.trim().match(/^\d+\./)[0] : "•";
        blocks.push({ type: "li", bullet, text: cleanInline(lm[1]) });
        i++;
        continue;
      }
      const p = [];
      while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,3}\s|>\s?|(?:[-*+]|\d+\.)\s)/.test(lines[i])) {
        p.push(cleanInline(lines[i]));
        i++;
      }
      blocks.push({ type: "p", text: p.join(" ") });
    }
    return blocks;
  }

  function dshCardTheme(styleId) {
    const T = window.Theme && Theme.dshTokens ? Theme.dshTokens : null;
    if (styleId === "paper") {
      return {
        bgTop: "#f7f5f0", bgBot: "#eeeae0", glow1: "rgba(75,103,180,0.08)", glow2: "rgba(180,140,90,0.08)",
        card: "rgba(255,255,255,0.96)", border: "rgba(35,32,26,0.12)",
        fg: "#1f1d18", fg2: "#5a554c", fg3: "#847e72", accent: T ? T.accent : "#4661ad",
        qBg: "#f2efe8", codeBg: "#f4f1ea", codeFg: "#29261f", quoteBg: "rgba(70,97,173,0.08)",
      };
    }
    if (styleId === "studio") {
      return {
        bgTop: "#0b0f19", bgBot: "#141b2d", glow1: "rgba(110,148,240,0.22)", glow2: "rgba(86,184,214,0.18)",
        card: "rgba(21,27,42,0.88)", border: "rgba(170,192,240,0.18)",
        fg: "#eef2fb", fg2: "#b4c0d8", fg3: "#7e8ca8", accent: "#7ea0f0",
        qBg: "rgba(126,160,240,0.14)", codeBg: "rgba(10,14,24,0.82)", codeFg: "#dce6fa", quoteBg: "rgba(126,160,240,0.12)",
      };
    }
    // aurora：跟随当前极光色板与深浅模式
    const dark = (window.Theme && Theme.current) === "dark";
    if (T) {
      return {
        bgTop: T.bgTop, bgBot: T.bgBot,
        glow1: dark ? "rgba(125,158,240,0.24)" : "rgba(75,103,180,0.18)",
        glow2: dark ? "rgba(92,184,218,0.20)" : "rgba(90,167,216,0.16)",
        card: dark ? "rgba(22,28,42,0.84)" : "rgba(255,255,255,0.86)",
        border: dark ? "rgba(180,200,245,0.18)" : "rgba(75,103,180,0.16)",
        fg: T.fg, fg2: T.fg2, fg3: T.fg3, accent: T.accent,
        qBg: dark ? "rgba(130,160,235,0.16)" : "rgba(75,103,180,0.10)",
        codeBg: dark ? "rgba(10,13,22,0.72)" : "rgba(235,240,250,0.88)",
        codeFg: T.fg, quoteBg: dark ? "rgba(130,160,235,0.12)" : "rgba(75,103,180,0.08)",
      };
    }
    return dshCardTheme(dark ? "studio" : "paper");
  }

  function dshDrawShareCard(cv, opts) {
    const W = 720, PAD = 34, CARD_PAD = 30, INNER = W - PAD * 2 - CARD_PAD * 2;
    const th = dshCardTheme(opts.style);
    const uiFont = '"CC Inter", "CC Hei", -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    const monoFont = '"CC Mono", ui-monospace, monospace';
    const blocks = dshParseCardBlocks(opts.answer.slice(0, 6000));
    const qText = opts.showQ ? (opts.question || "").slice(0, 600) : "";

    // 第一遍量高度
    const mcv = document.createElement("canvas");
    const mg = mcv.getContext("2d");
    const ops = [];
    let y = PAD + CARD_PAD;

    // 顶部品牌与会话标题
    ops.push({ kind: "header", y });
    y += 46;

    // 提问气泡
    if (qText) {
      mg.font = `500 18px ${uiFont}`;
      const qLines = dshWrapText(mg, qText, INNER - 32).slice(0, 12);
      const qH = qLines.length * 28 + 26;
      ops.push({ kind: "question", y, h: qH, lines: qLines });
      y += qH + 22;
    }

    // 正文 Markdown 排版
    const MAX_Y = 3400;
    let truncated = false;
    for (const b of blocks) {
      if (y > MAX_Y) { truncated = true; break; }
      if (b.type === "h") {
        const sz = b.level === 1 ? 23 : b.level === 2 ? 20 : 18;
        mg.font = `700 ${sz}px ${uiFont}`;
        const lines = dshWrapText(mg, b.text, INNER);
        ops.push({ kind: "h", y, sz, lh: sz + 11, lines });
        y += lines.length * (sz + 11) + 10;
      } else if (b.type === "code") {
        mg.font = `400 15px ${monoFont}`;
        const lines = dshWrapText(mg, b.text, INNER - 28).slice(0, 28);
        const h = lines.length * 22 + (b.lang ? 38 : 24);
        ops.push({ kind: "code", y, h, lang: b.lang, lines });
        y += h + 14;
      } else if (b.type === "quote") {
        mg.font = `400 17px ${uiFont}`;
        const lines = dshWrapText(mg, b.text, INNER - 30);
        const h = lines.length * 27 + 20;
        ops.push({ kind: "quote", y, h, lines });
        y += h + 14;
      } else if (b.type === "li") {
        mg.font = `400 17.5px ${uiFont}`;
        const lines = dshWrapText(mg, b.text, INNER - 24);
        ops.push({ kind: "li", y, bullet: b.bullet, lines });
        y += lines.length * 28 + 8;
      } else {
        mg.font = `400 17.5px ${uiFont}`;
        const lines = dshWrapText(mg, b.text, INNER);
        ops.push({ kind: "p", y, lines });
        y += lines.length * 28 + 12;
      }
    }
    if (truncated) {
      ops.push({ kind: "ellipsis", y });
      y += 28;
    }

    const footH = opts.showMeta ? 48 : 18;
    const H = Math.max(320, y + footH + CARD_PAD + PAD);
    const dpr = Math.min(2, 7600 / H);
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    const g = cv.getContext("2d");
    g.scale(dpr, dpr);

    // 1. 渐变背景与氛围光斑
    const bgGrad = g.createLinearGradient(0, 0, W, H);
    bgGrad.addColorStop(0, th.bgTop);
    bgGrad.addColorStop(1, th.bgBot);
    g.fillStyle = bgGrad;
    g.fillRect(0, 0, W, H);

    const orb1 = g.createRadialGradient(W * 0.16, H * 0.12, 10, W * 0.16, H * 0.12, W * 0.56);
    orb1.addColorStop(0, th.glow1);
    orb1.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = orb1;
    g.fillRect(0, 0, W, H);

    const orb2 = g.createRadialGradient(W * 0.86, H * 0.88, 10, W * 0.86, H * 0.88, W * 0.58);
    orb2.addColorStop(0, th.glow2);
    orb2.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = orb2;
    g.fillRect(0, 0, W, H);

    // 2. 毛玻璃卡片主体
    const cardX = PAD, cardY = PAD, cardW = W - PAD * 2, cardH = H - PAD * 2;
    g.save();
    g.shadowColor = "rgba(10,16,32,0.16)";
    g.shadowBlur = 28;
    g.shadowOffsetY = 10;
    dshRoundRect(g, cardX, cardY, cardW, cardH, 24);
    g.fillStyle = th.card;
    g.fill();
    g.restore();

    dshRoundRect(g, cardX, cardY, cardW, cardH, 24);
    g.strokeStyle = th.border;
    g.lineWidth = 1.25;
    g.stroke();

    // 顶部细强调条
    g.save();
    dshRoundRect(g, cardX, cardY, cardW, cardH, 24);
    g.clip();
    g.fillStyle = th.accent;
    g.fillRect(cardX, cardY, cardW, 4);
    g.restore();

    // 3. 绘制排版块
    const x0 = cardX + CARD_PAD;
    g.textBaseline = "top";
    for (const op of ops) {
      if (op.kind === "header") {
        g.fillStyle = th.accent;
        g.beginPath();
        g.arc(x0 + 6, op.y + 11, 5, 0, Math.PI * 2);
        g.fill();
        g.font = `700 17px ${uiFont}`;
        g.fillStyle = th.fg;
        g.fillText(opts.title || "cccodroid", x0 + 20, op.y + 2, INNER - 20);
        g.strokeStyle = th.border;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x0, op.y + 34);
        g.lineTo(x0 + INNER, op.y + 34);
        g.stroke();
      } else if (op.kind === "question") {
        dshRoundRect(g, x0, op.y, INNER, op.h, 16);
        g.fillStyle = th.qBg;
        g.fill();
        g.font = `500 18px ${uiFont}`;
        g.fillStyle = th.fg;
        op.lines.forEach((ln, idx) => g.fillText(ln, x0 + 16, op.y + 13 + idx * 28));
      } else if (op.kind === "h") {
        g.font = `700 ${op.sz}px ${uiFont}`;
        g.fillStyle = th.fg;
        op.lines.forEach((ln, idx) => g.fillText(ln, x0, op.y + idx * op.lh));
      } else if (op.kind === "code") {
        dshRoundRect(g, x0, op.y, INNER, op.h, 12);
        g.fillStyle = th.codeBg;
        g.fill();
        g.strokeStyle = th.border;
        g.lineWidth = 1;
        g.stroke();
        let cy = op.y + 12;
        if (op.lang) {
          g.font = `600 12px ${monoFont}`;
          g.fillStyle = th.accent;
          g.fillText(op.lang.toUpperCase(), x0 + 14, cy);
          cy += 18;
        }
        g.font = `400 15px ${monoFont}`;
        g.fillStyle = th.codeFg;
        op.lines.forEach((ln, idx) => g.fillText(ln, x0 + 14, cy + idx * 22));
      } else if (op.kind === "quote") {
        dshRoundRect(g, x0, op.y, INNER, op.h, 10);
        g.fillStyle = th.quoteBg;
        g.fill();
        g.fillStyle = th.accent;
        g.fillRect(x0, op.y + 6, 3.5, op.h - 12);
        g.font = `400 17px ${uiFont}`;
        g.fillStyle = th.fg2;
        op.lines.forEach((ln, idx) => g.fillText(ln, x0 + 16, op.y + 10 + idx * 27));
      } else if (op.kind === "li") {
        g.font = `600 17px ${uiFont}`;
        g.fillStyle = th.accent;
        g.fillText(op.bullet, x0 + 2, op.y);
        g.font = `400 17.5px ${uiFont}`;
        g.fillStyle = th.fg;
        op.lines.forEach((ln, idx) => g.fillText(ln, x0 + 22, op.y + idx * 28));
      } else if (op.kind === "p") {
        g.font = `400 17.5px ${uiFont}`;
        g.fillStyle = th.fg;
        op.lines.forEach((ln, idx) => g.fillText(ln, x0, op.y + idx * 28));
      } else if (op.kind === "ellipsis") {
        g.font = `400 15px ${uiFont}`;
        g.fillStyle = th.fg3;
        g.fillText(t("……（内容较长，已节选前文）"), x0, op.y);
      }
    }

    // 4. 底部署名与时间
    if (opts.showMeta) {
      const fy = H - PAD - CARD_PAD - 26;
      g.strokeStyle = th.border;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x0, fy - 12);
      g.lineTo(x0 + INNER, fy - 12);
      g.stroke();
      g.font = `600 13.5px ${uiFont}`;
      g.fillStyle = th.fg2;
      const modelTxt = opts.model || "Claude";
      g.fillText(`cccodroid · ${modelTxt}`, x0, fy);
      g.font = `400 13px ${uiFont}`;
      g.fillStyle = th.fg3;
      const stamp = new Date().toLocaleString(I18N.lang, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      const sw = g.measureText(stamp).width;
      g.fillText(stamp, x0 + INNER - sw, fy);
    }
  }

  function openShareCard(msgEl, answerText) {
    const answer = String(answerText || "").trim();
    if (!answer) return toast(t("这条回复没有正文内容"), true);
    const question = msgEl ? findPrevQuestion(msgEl) : "";
    const modelChips = [...($("model-chip")?.querySelectorAll(".chip") || [])].map((x) => x.textContent.trim()).filter(Boolean);
    const opts = {
      style: "aurora",
      showQ: !!question,
      showMeta: true,
      question,
      answer,
      title: view.title || "cccodroid",
      model: modelChips[0] || "Claude",
    };

    const ov = document.createElement("div");
    ov.id = "dsh-card-ov";
    ov.innerHTML = `<div class="dsh-card-dlg" role="dialog" aria-modal="true" aria-label="${esc(t("分享卡片"))}">
      <div class="dsh-card-head">
        <b>${esc(t("对话分享卡"))}</b>
        <button type="button" class="icon-btn" data-act="close" aria-label="${esc(t("关闭"))}">
          <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="dsh-card-prev"><canvas id="dsh-card-cv"></canvas></div>
      <div class="dsh-card-ctrl">
        <div class="dsh-card-styles">
          <button type="button" data-st="aurora" class="on">${esc(t("极光毛玻璃"))}</button>
          <button type="button" data-st="paper">${esc(t("纯净纸感"))}</button>
          <button type="button" data-st="studio">${esc(t("深邃暗夜"))}</button>
        </div>
        <div class="dsh-card-opts">
          ${question ? `<label><input type="checkbox" data-opt="showQ" checked><span>${esc(t("包含提问"))}</span></label>` : ""}
          <label><input type="checkbox" data-opt="showMeta" checked><span>${esc(t("显示模型与时间"))}</span></label>
        </div>
        <div class="dsh-card-acts">
          <button type="button" class="btn ghost sm" data-act="save">${esc(t("保存图片"))}</button>
          <button type="button" class="btn sm" data-act="share">${esc(t("分享图片"))}</button>
        </div>
      </div>
    </div>`;

    const cv = ov.querySelector("#dsh-card-cv");
    const redraw = () => dshDrawShareCard(cv, opts);
    redraw();

    const exportCard = async (mode) => {
      const d = new Date(), p = (x) => String(x).padStart(2, "0");
      const rand = Math.random().toString(36).slice(2, 6);
      const name = `cccodroid-card-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, "0")}-${rand}.png`;
      const dataUrl = cv.toDataURL("image/png");
      const inApp = !!window.CCApp;
      let filePath = "", errMsg = "";
      try {
        const res = await post("/api/usage/card", { name, data: dataUrl.split(",")[1], private: true });
        if (res && res.file) filePath = res.file;
        else errMsg = (res && (res.message || res.error)) || "";
      } catch (e) { errMsg = (e && e.message) || ""; }
      if (mode === "save") {
        if (filePath && canSaveAs()) return saveAs(filePath, "image/png");
        if (inApp) {
          toast(filePath ? t("已保存到导出目录：{name}", { name }) : (errMsg ? t("保存图片失败：{msg}", { msg: errMsg }) : t("保存图片失败")), !filePath);
          return;
        }
        const a = document.createElement("a");
        a.href = dataUrl;
        a.download = name;
        a.click();
        toast(filePath ? t("已保存：{name}", { name }) : t("已下载图片"));
        return;
      }
      if (filePath && canShare()) {
        try {
          const j = await post("/api/app/share_file", { path: filePath, mime: "image/png" });
          if (j && j.ok) return;
          errMsg = (j && (j.message || j.error)) || errMsg;
        } catch (e) { errMsg = (e && e.message) || errMsg; }
      }
      if (inApp) {
        if (filePath && canSaveAs()) return saveAs(filePath, "image/png");
        toast(errMsg ? t("分享图片失败：{msg}", { msg: errMsg }) : t("分享图片失败"), true);
        return;
      }
      if (navigator.canShare) {
        try {
          const blob = await (await fetch(dataUrl)).blob();
          const f = new File([blob], name, { type: "image/png" });
          if (navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], title: opts.title }); return; }
        } catch {}
      }
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = name;
      a.click();
      toast(t("已保存图片，可直接转发"));
    };

    const close = () => OV.close(ov);
    ov.addEventListener("click", (e) => {
      if (e.target === ov) return close();
      const st = e.target.closest("[data-st]");
      if (st) {
        opts.style = st.dataset.st;
        ov.querySelectorAll("[data-st]").forEach((b) => b.classList.toggle("on", b === st));
        redraw();
        return;
      }
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "close") close();
      else if (act === "save") exportCard("save");
      else if (act === "share") exportCard("share");
    });
    ov.addEventListener("change", (e) => {
      const k = e.target.dataset && e.target.dataset.opt;
      if (k) { opts[k] = e.target.checked; redraw(); }
    });
    OV.open(ov, { kind: "modal", keep: true, cover: true });
  }
