// Injected into the page context so we can patch fetch/XHR and access performance.memory
(function () {
  "use strict";
  if (window.__jenkMeter) { window.__jenkMeter.stop(); window.__jenkMeter = null; }

  // ── Helpers ──────────────────────────────────────────

  const now = () => performance.now();
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  const fmtMs = (ms) => (!isFinite(ms) || ms < 0) ? "NA" : `${Math.round(ms)}ms`;
  const fmtPct = (p) => (!isFinite(p) || p < 0) ? "NA" : `${Math.round(p)}%`;
  const fmtMem = (bytes) => {
    if (!isFinite(bytes) || bytes <= 0) return "NA";
    const mb = bytes / (1024 ** 2);
    return mb >= 1024 ? `${(mb / 1024).toFixed(2)}GB` : `${Math.round(mb)}MB`;
  };

  const heapUsed = () => performance?.memory?.usedJSHeapSize ?? null;

  // Color levels
  const C = { green: "#4ade80", yellow: "#facc15", red: "#f87171", dim: "rgba(255,255,255,0.5)" };

  const memLvl = (b) => b == null ? "dim" : (b / 1024 ** 2) < 100 ? "green" : (b / 1024 ** 2) < 500 ? "yellow" : "red";
  const delayLvl = (ms) => !isFinite(ms) ? "dim" : ms < 50 ? "green" : ms < 150 ? "yellow" : "red";
  const jankLvl = (p) => !isFinite(p) ? "dim" : p < 5 ? "green" : p < 20 ? "yellow" : "red";
  const netLvl = (n) => n === 0 ? "green" : n <= 3 ? "yellow" : "red";
  const fpsLvl = (fps) => !isFinite(fps) ? "dim" : fps >= 55 ? "green" : fps >= 30 ? "yellow" : "red";

  // ── Rolling window ───────────────────────────────────

  class RollingWindow {
    constructor(ms) { this.ms = ms; this.evts = []; }
    push(v, t = now()) {
      this.evts.push({ t, v });
      this._prune(t);
    }
    _prune(t = now()) {
      const cut = t - this.ms;
      let i = 0;
      while (i < this.evts.length && this.evts[i].t < cut) i++;
      if (i) this.evts.splice(0, i);
    }
    values(t = now()) { this._prune(t); return this.evts.map(e => e.v); }
    max(t = now()) {
      const v = this.values(t);
      if (!v.length) return NaN;
      let m = -Infinity;
      for (const x of v) if (x > m) m = x;
      return m;
    }
  }

  // ── State ────────────────────────────────────────────

  const WIN_MS = 2000;
  const BUDGET = 1000 / 60;
  const JANK_THRESH = BUDGET; // any frame over 16.67ms = janky

  const frameDeltas = new RollingWindow(WIN_MS);
  const loopLag = new RollingWindow(WIN_MS);
  let inFlightNet = 0;
  let lastRafT = null;
  let rafId = null;
  let lagTimer = null;
  let lagExpectedT = null;
  let tickTimer = null;
  let origFetch = null;
  let origXHROpen = null;
  let origXHRSend = null;

  // Jank breakdown tracking
  const longTasks = new RollingWindow(10000);       // 10s window
  const layoutShifts = new RollingWindow(10000);
  const longFrames = new RollingWindow(10000);       // long-animation-frame entries
  let longTaskObserver = null;
  let layoutShiftObserver = null;
  let longFrameObserver = null;

  // DOM refs
  const cells = {};
  let netBar = null;
  let rootEl = null;
  let tooltipEl = null;
  let tooltipVisible = false;

  // ── DOM ──────────────────────────────────────────────

  function mount() {
    if (document.querySelector("[data-jank-meter]")) return;

    const el = document.createElement("div");
    el.setAttribute("data-jank-meter", "");
    Object.assign(el.style, {
      position: "fixed", left: "0", right: "0", bottom: "0",
      height: "32px", lineHeight: "32px",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: "12px", padding: "0 12px",
      background: "rgba(15, 15, 15, 0.82)",
      color: "rgba(255,255,255,0.92)",
      zIndex: "2147483647",
      display: "flex", alignItems: "center", gap: "0",
      userSelect: "none",
      backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
      borderTop: "1px solid rgba(255,255,255,0.06)",
    });

    // ⌘ icon
    const icon = document.createElement("span");
    icon.textContent = "⌘";
    icon.style.cssText = "margin-right:14px;font-size:14px;opacity:0.6;";
    el.appendChild(icon);

    for (const name of ["FPS", "Mem", "Delay", "Jank", "Net"]) {
      const cell = document.createElement("span");
      cell.style.cssText = "margin-right:20px;white-space:nowrap;";

      const label = document.createElement("span");
      label.textContent = name + " ";
      label.style.cssText = "color:rgba(255,255,255,0.45);";
      cell.appendChild(label);

      const value = document.createElement("span");
      value.textContent = "NA";
      value.style.cssText = "font-weight:500;";
      cell.appendChild(value);
      cells[name] = value;

      if (name === "Jank") {
        cell.style.cursor = "pointer";
        cell.addEventListener("click", (e) => {
          e.stopPropagation();
          tooltipVisible = !tooltipVisible;
          if (tooltipEl) tooltipEl.style.display = tooltipVisible ? "block" : "none";
        });
      }

      if (name === "Net") {
        const wrap = document.createElement("span");
        wrap.style.cssText = "display:inline-block;width:40px;height:4px;background:rgba(255,255,255,0.1);border-radius:2px;margin-left:6px;vertical-align:middle;overflow:hidden;";
        const bar = document.createElement("div");
        bar.style.cssText = "height:100%;width:0%;border-radius:2px;transition:width 0.2s ease;";
        wrap.appendChild(bar);
        cell.appendChild(wrap);
        netBar = bar;
      }

      el.appendChild(cell);
    }

    // Spacer
    const spacer = document.createElement("span");
    spacer.style.flex = "1";
    el.appendChild(spacer);

    // Collapse
    let collapsed = false;
    const colBtn = makeBtn("↓", () => {
      collapsed = !collapsed;
      colBtn.textContent = collapsed ? "↑" : "↓";
      for (const v of Object.values(cells))
        v.parentElement.style.display = collapsed ? "none" : "";
      icon.style.display = collapsed ? "none" : "";
    });
    el.appendChild(colBtn);

    // Close
    el.appendChild(makeBtn("—", stop));

    // Jank breakdown tooltip
    const tip = document.createElement("div");
    tip.setAttribute("data-jank-tooltip", "");
    Object.assign(tip.style, {
      position: "fixed", bottom: "36px", left: "12px",
      background: "rgba(15, 15, 15, 0.94)",
      backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
      border: "1px solid rgba(255,255,255,0.1)",
      borderRadius: "8px",
      padding: "12px 16px",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: "11px", lineHeight: "1.6",
      color: "rgba(255,255,255,0.85)",
      zIndex: "2147483647",
      minWidth: "280px", maxWidth: "360px",
      display: "none",
      pointerEvents: "auto",
    });
    document.documentElement.appendChild(tip);
    tooltipEl = tip;

    // Close tooltip when clicking outside
    document.addEventListener("click", (e) => {
      if (tooltipVisible && !tip.contains(e.target) && !el.contains(e.target)) {
        tooltipVisible = false;
        tip.style.display = "none";
      }
    });

    document.documentElement.appendChild(el);
    rootEl = el;
  }

  function makeBtn(text, onClick) {
    const b = document.createElement("span");
    b.textContent = text;
    b.style.cssText = "cursor:pointer;padding:0 6px;opacity:0.4;font-size:14px;";
    b.addEventListener("mouseenter", () => b.style.opacity = "0.9");
    b.addEventListener("mouseleave", () => b.style.opacity = "0.4");
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  // ── Render ───────────────────────────────────────────

  function render() {
    if (!rootEl) return;
    const t = now();

    // FPS: average from frame deltas
    const deltas = frameDeltas.values(t);
    let fps = NaN;
    if (deltas.length > 1) {
      const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      fps = avg > 0 ? 1000 / avg : NaN;
    }
    cells.FPS.textContent = isNaN(fps) ? "NA" : String(Math.round(fps));
    cells.FPS.style.color = C[fpsLvl(fps)];

    const heap = heapUsed();
    cells.Mem.textContent = heap == null ? "NA" : fmtMem(heap);
    cells.Mem.style.color = C[memLvl(heap)];

    const lag = loopLag.max(t);
    cells.Delay.textContent = isNaN(lag) ? "NA" : fmtMs(lag);
    cells.Delay.style.color = C[delayLvl(lag)];

    let jp = NaN;
    if (deltas.length) {
      const bad = deltas.filter(d => d > JANK_THRESH).length;
      jp = (bad / deltas.length) * 100;
    }
    cells.Jank.textContent = isNaN(jp) ? "NA" : fmtPct(jp);
    cells.Jank.style.color = C[jankLvl(jp)];

    renderTooltip(t, deltas);

    cells.Net.textContent = String(inFlightNet);
    const nl = netLvl(inFlightNet);
    cells.Net.style.color = C[nl];
    if (netBar) {
      netBar.style.width = `${clamp(inFlightNet * 15, 0, 100)}%`;
      netBar.style.background = C[nl];
    }
  }

  // ── Measurement loops ────────────────────────────────

  function startRaf() {
    const loop = (ts) => {
      if (lastRafT != null) {
        const d = ts - lastRafT;
        if (d < 1000) frameDeltas.push(d, now());
      }
      lastRafT = ts;
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }

  function startLagProbe() {
    const interval = 50;
    lagExpectedT = now() + interval;
    const tick = () => {
      const t = now();
      if (lagExpectedT != null)
        loopLag.push(clamp(Math.max(0, t - lagExpectedT), 0, 2000), t);
      lagExpectedT = t + interval;
      lagTimer = setTimeout(tick, interval);
    };
    lagTimer = setTimeout(tick, interval);
  }

  // ── Network patches ──────────────────────────────────

  function patchFetch() {
    if (typeof window.fetch !== "function") return;
    origFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      inFlightNet++;
      try { return await origFetch(input, init); }
      finally { inFlightNet = Math.max(0, inFlightNet - 1); }
    };
  }

  function patchXHR() {
    if (typeof XMLHttpRequest === "undefined") return;
    const proto = XMLHttpRequest.prototype;
    origXHROpen = proto.open;
    origXHRSend = proto.send;
    proto.open = function (...args) { this.__jm = true; return origXHROpen.apply(this, args); };
    proto.send = function (...args) {
      if (this.__jm) {
        inFlightNet++;
        const done = () => {
          inFlightNet = Math.max(0, inFlightNet - 1);
          for (const e of ["loadend", "error", "abort", "timeout"]) this.removeEventListener(e, done);
        };
        for (const e of ["loadend", "error", "abort", "timeout"]) this.addEventListener(e, done);
      }
      return origXHRSend.apply(this, args);
    };
  }

  // ── Lifecycle ────────────────────────────────────────

  function startObservers() {
    // Long Tasks (>50ms main-thread blocks)
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks.push(entry.duration);
        }
      });
      longTaskObserver.observe({ type: "longtask", buffered: true });
    } catch (e) {}

    // Layout Shifts
    try {
      layoutShiftObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) {
            layoutShifts.push(entry.value);
          }
        }
      });
      layoutShiftObserver.observe({ type: "layout-shift", buffered: true });
    } catch (e) {}

    // Long Animation Frames (Chrome 123+)
    try {
      longFrameObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longFrames.push(entry.duration);
        }
      });
      longFrameObserver.observe({ type: "long-animation-frame", buffered: true });
    } catch (e) {}
  }

  function renderTooltip(t, deltas) {
    if (!tooltipEl || !tooltipVisible) return;

    // Frame time stats
    const sorted = [...deltas].sort((a, b) => a - b);
    const worst = sorted.length ? sorted[sorted.length - 1] : NaN;
    const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : NaN;
    const p50 = sorted.length ? sorted[Math.floor(sorted.length * 0.5)] : NaN;
    const dropped = deltas.filter(d => d > BUDGET).length;
    const total = deltas.length;

    // Histogram buckets
    const buckets = [
      { label: "<16ms", max: 16, count: 0 },
      { label: "16-33ms", max: 33, count: 0 },
      { label: "33-50ms", max: 50, count: 0 },
      { label: "50-100ms", max: 100, count: 0 },
      { label: ">100ms", max: Infinity, count: 0 },
    ];
    let prevMax = 0;
    for (const b of buckets) {
      b.count = deltas.filter(d => d > prevMax && d <= b.max).length;
      prevMax = b.max;
    }
    const maxBucket = Math.max(1, ...buckets.map(b => b.count));

    // Long tasks
    const ltVals = longTasks.values(t);
    const ltCount = ltVals.length;
    const ltWorst = ltVals.length ? Math.max(...ltVals) : 0;

    // Layout shifts
    const lsVals = layoutShifts.values(t);
    const clsSum = lsVals.reduce((a, b) => a + b, 0);

    // Long animation frames
    const lfVals = longFrames.values(t);
    const lfCount = lfVals.length;
    const lfWorst = lfVals.length ? Math.max(...lfVals) : 0;

    // Lag
    const lagMax = loopLag.max(t);
    const lagVals = loopLag.values(t);
    const lagAvg = lagVals.length ? lagVals.reduce((a, b) => a + b, 0) / lagVals.length : 0;

    const dim = "rgba(255,255,255,0.4)";
    const bright = "rgba(255,255,255,0.9)";

    // Build histogram bars
    const barHtml = buckets.map(b => {
      const pct = Math.round((b.count / maxBucket) * 100);
      const color = b.max <= 16 ? C.green : b.max <= 33 ? C.yellow : b.max <= 50 ? "#fb923c" : C.red;
      return `<div style="display:flex;align-items:center;gap:8px;margin:1px 0;">` +
        `<span style="width:60px;text-align:right;color:${dim};font-size:10px;">${b.label}</span>` +
        `<div style="flex:1;height:6px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden;">` +
        `<div style="height:100%;width:${pct}%;background:${color};border-radius:3px;"></div></div>` +
        `<span style="width:24px;font-size:10px;color:${dim};">${b.count}</span></div>`;
    }).join("");

    tooltipEl.innerHTML =
      `<div style="margin-bottom:8px;font-weight:600;color:${bright};font-size:12px;">Jank Breakdown <span style="font-weight:400;color:${dim};">(last 10s)</span></div>` +

      `<div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 16px;margin-bottom:10px;">` +
      `<span style="color:${dim};">Dropped frames</span><span style="color:${dropped > 0 ? C.red : C.green};">${dropped}/${total}</span>` +
      `<span style="color:${dim};">Worst frame</span><span style="color:${worst > 50 ? C.red : worst > BUDGET ? C.yellow : C.green};">${fmtMs(worst)}</span>` +
      `<span style="color:${dim};">p95 frame</span><span style="color:${p95 > 50 ? C.red : p95 > BUDGET ? C.yellow : C.green};">${fmtMs(p95)}</span>` +
      `<span style="color:${dim};">p50 frame</span><span style="color:${C.green};">${fmtMs(p50)}</span>` +
      `</div>` +

      `<div style="margin-bottom:8px;font-weight:500;color:${bright};font-size:11px;">Frame distribution</div>` +
      `<div style="margin-bottom:10px;">${barHtml}</div>` +

      `<div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 16px;">` +
      `<span style="color:${dim};">Long tasks (&gt;50ms)</span><span style="color:${ltCount > 0 ? C.yellow : C.green};">${ltCount}${ltCount > 0 ? ` (worst ${fmtMs(ltWorst)})` : ""}</span>` +
      `<span style="color:${dim};">Long frames</span><span style="color:${lfCount > 0 ? C.yellow : C.green};">${lfCount}${lfCount > 0 ? ` (worst ${fmtMs(lfWorst)})` : ""}</span>` +
      `<span style="color:${dim};">Layout shift (CLS)</span><span style="color:${clsSum > 0.1 ? C.red : clsSum > 0.01 ? C.yellow : C.green};">${clsSum.toFixed(4)}</span>` +
      `<span style="color:${dim};">Loop lag (avg)</span><span style="color:${delayLvl(lagAvg) === "dim" ? C.green : C[delayLvl(lagAvg)]};">${fmtMs(lagAvg)}</span>` +
      `<span style="color:${dim};">Loop lag (max)</span><span style="color:${C[delayLvl(lagMax)]};">${isNaN(lagMax) ? "NA" : fmtMs(lagMax)}</span>` +
      `</div>`;
  }

  function start() {
    mount();
    startRaf();
    startLagProbe();
    startObservers();
    patchFetch();
    patchXHR();
    tickTimer = setInterval(render, 200);
  }

  function stop() {
    if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
    lastRafT = null;
    if (lagTimer != null) { clearTimeout(lagTimer); lagTimer = null; }
    if (tickTimer != null) { clearInterval(tickTimer); tickTimer = null; }
    if (origFetch) { window.fetch = origFetch; origFetch = null; }
    if (origXHROpen) {
      XMLHttpRequest.prototype.open = origXHROpen;
      XMLHttpRequest.prototype.send = origXHRSend;
      origXHROpen = origXHRSend = null;
    }
    if (longTaskObserver) { longTaskObserver.disconnect(); longTaskObserver = null; }
    if (layoutShiftObserver) { layoutShiftObserver.disconnect(); layoutShiftObserver = null; }
    if (longFrameObserver) { longFrameObserver.disconnect(); longFrameObserver = null; }
    if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
    if (rootEl) { rootEl.remove(); rootEl = null; }
    window.__jenkMeter = null;
  }

  // Listen for stop message from content script
  window.addEventListener("message", (e) => {
    if (e.data?.type === "JENK_METER_STOP") stop();
  });

  // Go
  window.__jenkMeter = { stop };
  start();
})();
