// jank-meter.ts — Linear-style dev toolbar overlay
// Measures: Mem (JS heap), Delay (event-loop lag), Jank% (bad frames),
//           Net (in-flight requests), Hydr (hydration duration)

export type JankMeterOptions = {
  enabled?: boolean;
  position?: "top" | "bottom";
  zIndex?: number;
  budgetMs?: number;
  jankThresholdMs?: number;
  windowMs?: number;
  sampleIntervalMs?: number;
  instrumentFetch?: boolean;
  instrumentXHR?: boolean;
  enableHydrationHeuristic?: boolean;
  extraFields?: () => Record<string, string | number | null | undefined>;
};

// ── Helpers ──────────────────────────────────────────────

function now(): number {
  return performance?.now ? performance.now() : Date.now();
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function formatMs(ms: number): string {
  if (!isFinite(ms) || ms < 0) return "NA";
  return `${Math.round(ms)}ms`;
}

function formatPct(p: number): string {
  if (!isFinite(p) || p < 0) return "NA";
  return `${Math.round(p)}%`;
}

function formatMB(bytes: number): string {
  if (!isFinite(bytes) || bytes <= 0) return "NA";
  const mb = bytes / (1024 ** 2);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)}GB`;
  return `${Math.round(mb)}MB`;
}

function heapUsed(): number | null {
  const p = performance as any;
  return p?.memory?.usedJSHeapSize ?? null;
}

// Color thresholds → CSS color
type Level = "green" | "yellow" | "red" | "dim";
const COLORS: Record<Level, string> = {
  green: "#4ade80",
  yellow: "#facc15",
  red: "#f87171",
  dim: "rgba(255,255,255,0.5)",
};

function memLevel(bytes: number | null): Level {
  if (bytes == null) return "dim";
  const mb = bytes / (1024 ** 2);
  if (mb < 100) return "green";
  if (mb < 500) return "yellow";
  return "red";
}

function delayLevel(ms: number): Level {
  if (!isFinite(ms)) return "dim";
  if (ms < 50) return "green";
  if (ms < 150) return "yellow";
  return "red";
}

function jankLevel(pct: number): Level {
  if (!isFinite(pct)) return "dim";
  if (pct < 5) return "green";
  if (pct < 20) return "yellow";
  return "red";
}

function netLevel(n: number): Level {
  if (n === 0) return "green";
  if (n <= 3) return "yellow";
  return "red";
}

function hydrLevel(ms: number): Level {
  if (!isFinite(ms)) return "dim";
  if (ms < 1000) return "green";
  if (ms < 3000) return "yellow";
  return "red";
}

// ── Rolling window ───────────────────────────────────────

type Evt = { t: number; v: number };

class RollingWindow {
  private evts: Evt[] = [];
  constructor(private windowMs: number) {}

  push(v: number, t = now()) {
    this.evts.push({ t, v });
    this.prune(t);
  }

  private prune(t = now()) {
    const cutoff = t - this.windowMs;
    let i = 0;
    while (i < this.evts.length && this.evts[i].t < cutoff) i++;
    if (i > 0) this.evts.splice(0, i);
  }

  values(t = now()): number[] {
    this.prune(t);
    return this.evts.map(e => e.v);
  }

  max(t = now()): number {
    const vals = this.values(t);
    if (!vals.length) return NaN;
    let m = -Infinity;
    for (const v of vals) if (v > m) m = v;
    return m;
  }
}

// ── Hydration state ──────────────────────────────────────

type HydrationState =
  | { status: "NA" }
  | { status: "RUNNING"; startT: number }
  | { status: "DONE"; durationMs: number };

// ── JankMeter ────────────────────────────────────────────

export class JankMeter {
  private opts: Required<JankMeterOptions>;
  private root: HTMLDivElement | null = null;
  private rafId: number | null = null;
  private tickTimer: number | null = null;

  private frameDeltas: RollingWindow;
  private loopLag: RollingWindow;
  private inFlightNet = 0;
  private hydration: HydrationState = { status: "NA" };
  private hydrationAttached = false;

  private origFetch: typeof fetch | null = null;
  private origXHROpen: Function | null = null;
  private origXHRSend: Function | null = null;

  private lastRafT: number | null = null;
  private lagTimer: number | null = null;
  private lagExpectedT: number | null = null;

  // UI state
  private collapsed = false;
  private hidden = false;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  // DOM refs for fast updates
  private cells: Map<string, HTMLSpanElement> = new Map();
  private netBar: HTMLDivElement | null = null;

  constructor(options: JankMeterOptions = {}) {
    const budgetMs = options.budgetMs ?? 1000 / 60;
    this.opts = {
      enabled: options.enabled ?? true,
      position: options.position ?? "bottom",
      zIndex: options.zIndex ?? 2147483647,
      budgetMs,
      jankThresholdMs: options.jankThresholdMs ?? budgetMs * 1.5,
      windowMs: options.windowMs ?? 2000,
      sampleIntervalMs: options.sampleIntervalMs ?? 200,
      instrumentFetch: options.instrumentFetch ?? true,
      instrumentXHR: options.instrumentXHR ?? true,
      enableHydrationHeuristic: options.enableHydrationHeuristic ?? true,
      extraFields: options.extraFields ?? (() => ({})),
    };
    this.frameDeltas = new RollingWindow(this.opts.windowMs);
    this.loopLag = new RollingWindow(this.opts.windowMs);
  }

  // ── Public API ───────────────────────────────────────

  start() {
    if (!this.opts.enabled || typeof window === "undefined") return;
    this.mountOverlay();
    this.startRaf();
    this.startLagProbe();
    this.startTicker();
    if (this.opts.instrumentFetch) this.patchFetch();
    if (this.opts.instrumentXHR) this.patchXHR();
    if (this.opts.enableHydrationHeuristic) this.attachHydration();
    this.keyHandler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === "J") {
        this.hidden = !this.hidden;
        if (this.root) this.root.style.display = this.hidden ? "none" : "flex";
      }
    };
    window.addEventListener("keydown", this.keyHandler);
  }

  stop() {
    this.stopRaf();
    this.stopLagProbe();
    if (this.tickTimer != null) { clearInterval(this.tickTimer); this.tickTimer = null; }
    this.unpatchFetch();
    this.unpatchXHR();
    if (this.keyHandler) { window.removeEventListener("keydown", this.keyHandler); this.keyHandler = null; }
    if (this.root) { this.root.remove(); this.root = null; }
  }

  markHydrationStart() { this.hydration = { status: "RUNNING", startT: now() }; }
  markHydrationEnd() {
    if (this.hydration.status === "RUNNING")
      this.hydration = { status: "DONE", durationMs: now() - this.hydration.startT };
  }

  // ── Overlay DOM ──────────────────────────────────────

  private mountOverlay() {
    if (this.root) return;
    const el = document.createElement("div");
    el.setAttribute("data-jank-meter", "");
    Object.assign(el.style, {
      position: "fixed",
      left: "0", right: "0",
      [this.opts.position]: "0",
      height: "32px",
      lineHeight: "32px",
      fontFamily: `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`,
      fontSize: "12px",
      padding: "0 12px",
      background: "rgba(15, 15, 15, 0.82)",
      color: "rgba(255,255,255,0.92)",
      zIndex: String(this.opts.zIndex),
      display: "flex",
      alignItems: "center",
      gap: "0",
      userSelect: "none",
      backdropFilter: "blur(8px)",
      WebkitBackdropFilter: "blur(8px)",
      borderTop: this.opts.position === "bottom" ? "1px solid rgba(255,255,255,0.06)" : "none",
      borderBottom: this.opts.position === "top" ? "1px solid rgba(255,255,255,0.06)" : "none",
    });

    // ⌘ icon
    const icon = document.createElement("span");
    icon.textContent = "⌘";
    icon.style.cssText = "margin-right:14px;font-size:14px;opacity:0.6;";
    el.appendChild(icon);

    // Metric cells
    const metrics = ["Mem", "Delay", "Jank", "Net", "Hydr"];
    for (const name of metrics) {
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
      this.cells.set(name, value);

      // Net gets a progress bar
      if (name === "Net") {
        const barWrap = document.createElement("span");
        barWrap.style.cssText = "display:inline-block;width:40px;height:4px;background:rgba(255,255,255,0.1);border-radius:2px;margin-left:6px;vertical-align:middle;overflow:hidden;";
        const bar = document.createElement("div");
        bar.style.cssText = "height:100%;width:0%;border-radius:2px;transition:width 0.2s ease;";
        barWrap.appendChild(bar);
        cell.appendChild(barWrap);
        this.netBar = bar;
      }

      el.appendChild(cell);
    }

    // Spacer
    const spacer = document.createElement("span");
    spacer.style.cssText = "flex:1;";
    el.appendChild(spacer);

    // Collapse button
    const collapseBtn = this.makeBtn("↓", () => {
      this.collapsed = !this.collapsed;
      collapseBtn.textContent = this.collapsed ? "↑" : "↓";
      for (const [, v] of this.cells) {
        (v.parentElement as HTMLElement).style.display = this.collapsed ? "none" : "";
      }
      icon.style.display = this.collapsed ? "none" : "";
    });
    el.appendChild(collapseBtn);

    // Minimize button
    const minBtn = this.makeBtn("—", () => {
      this.hidden = true;
      el.style.display = "none";
    });
    el.appendChild(minBtn);

    document.documentElement.appendChild(el);
    this.root = el;
  }

  private makeBtn(text: string, onClick: () => void): HTMLSpanElement {
    const btn = document.createElement("span");
    btn.textContent = text;
    btn.style.cssText = "cursor:pointer;padding:0 6px;opacity:0.4;font-size:14px;";
    btn.addEventListener("mouseenter", () => btn.style.opacity = "0.9");
    btn.addEventListener("mouseleave", () => btn.style.opacity = "0.4");
    btn.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return btn;
  }

  // ── Render ───────────────────────────────────────────

  private render() {
    if (!this.root || this.hidden) return;
    const t = now();

    // Mem
    const heap = heapUsed();
    const memCell = this.cells.get("Mem")!;
    memCell.textContent = heap == null ? "NA" : formatMB(heap);
    memCell.style.color = COLORS[memLevel(heap)];

    // Delay
    const lagMax = this.loopLag.max(t);
    const delayCell = this.cells.get("Delay")!;
    delayCell.textContent = isNaN(lagMax) ? "NA" : formatMs(lagMax);
    delayCell.style.color = COLORS[delayLevel(lagMax)];

    // Jank
    const deltas = this.frameDeltas.values(t);
    let jankPct = NaN;
    if (deltas.length > 0) {
      const bad = deltas.filter(d => d > this.opts.jankThresholdMs).length;
      jankPct = (bad / deltas.length) * 100;
    }
    const jankCell = this.cells.get("Jank")!;
    jankCell.textContent = isNaN(jankPct) ? "NA" : formatPct(jankPct);
    jankCell.style.color = COLORS[jankLevel(jankPct)];

    // Net
    const netCell = this.cells.get("Net")!;
    netCell.textContent = String(this.inFlightNet);
    const nl = netLevel(this.inFlightNet);
    netCell.style.color = COLORS[nl];
    if (this.netBar) {
      const pct = clamp(this.inFlightNet * 15, 0, 100);
      this.netBar.style.width = `${pct}%`;
      this.netBar.style.background = COLORS[nl];
    }

    // Hydr
    const hydrCell = this.cells.get("Hydr")!;
    if (this.hydration.status === "NA") {
      hydrCell.textContent = "NA";
      hydrCell.style.color = COLORS.dim;
    } else if (this.hydration.status === "RUNNING") {
      hydrCell.textContent = "…";
      hydrCell.style.color = COLORS.yellow;
    } else {
      hydrCell.textContent = formatMs(this.hydration.durationMs);
      hydrCell.style.color = COLORS[hydrLevel(this.hydration.durationMs)];
    }
  }

  // ── RAF loop ─────────────────────────────────────────

  private startRaf() {
    if (this.rafId != null) return;
    const loop = (ts: number) => {
      if (this.lastRafT != null) {
        const delta = ts - this.lastRafT;
        if (delta < 1000) this.frameDeltas.push(delta, now());
      }
      this.lastRafT = ts;
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private stopRaf() {
    if (this.rafId != null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    this.lastRafT = null;
  }

  // ── Event-loop lag ───────────────────────────────────

  private startLagProbe() {
    if (this.lagTimer != null) return;
    const interval = 50;
    this.lagExpectedT = now() + interval;
    const tick = () => {
      const t = now();
      if (this.lagExpectedT != null) {
        this.loopLag.push(clamp(Math.max(0, t - this.lagExpectedT), 0, 2000), t);
      }
      this.lagExpectedT = t + interval;
      this.lagTimer = window.setTimeout(tick, interval);
    };
    this.lagTimer = window.setTimeout(tick, interval);
  }

  private stopLagProbe() {
    if (this.lagTimer != null) { clearTimeout(this.lagTimer); this.lagTimer = null; }
    this.lagExpectedT = null;
  }

  // ── Ticker ───────────────────────────────────────────

  private startTicker() {
    if (this.tickTimer != null) return;
    this.tickTimer = window.setInterval(() => this.render(), this.opts.sampleIntervalMs);
  }

  // ── Network patches ──────────────────────────────────

  private patchFetch() {
    if (this.origFetch || typeof window.fetch !== "function") return;
    this.origFetch = window.fetch.bind(window);
    const self = this;
    window.fetch = (async (input: any, init?: any) => {
      self.inFlightNet++;
      try { return await self.origFetch!(input, init); }
      finally { self.inFlightNet = Math.max(0, self.inFlightNet - 1); }
    }) as typeof fetch;
  }

  private unpatchFetch() {
    if (this.origFetch) { window.fetch = this.origFetch; this.origFetch = null; }
  }

  private patchXHR() {
    if (this.origXHROpen || typeof XMLHttpRequest === "undefined") return;
    const proto = XMLHttpRequest.prototype as any;
    this.origXHROpen = proto.open;
    this.origXHRSend = proto.send;
    const self = this;

    proto.open = function (...args: any[]) {
      (this as any).__jm = true;
      return self.origXHROpen!.apply(this, args);
    };
    proto.send = function (...args: any[]) {
      if ((this as any).__jm) {
        self.inFlightNet++;
        const done = () => {
          self.inFlightNet = Math.max(0, self.inFlightNet - 1);
          for (const e of ["loadend", "error", "abort", "timeout"]) this.removeEventListener(e, done);
        };
        for (const e of ["loadend", "error", "abort", "timeout"]) this.addEventListener(e, done);
      }
      return self.origXHRSend!.apply(this, args);
    };
  }

  private unpatchXHR() {
    if (!this.origXHROpen) return;
    const proto = XMLHttpRequest.prototype as any;
    proto.open = this.origXHROpen;
    proto.send = this.origXHRSend;
    this.origXHROpen = this.origXHRSend = null;
  }

  // ── Hydration heuristic ──────────────────────────────

  private attachHydration() {
    if (this.hydrationAttached || this.hydration.status !== "NA") return;
    this.hydrationAttached = true;
    this.hydration = { status: "RUNNING", startT: performance.timeOrigin ?? Date.now() };

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      this.hydration = { status: "DONE", durationMs: now() };
      for (const e of ["pointerdown", "keydown", "touchstart"])
        window.removeEventListener(e, finish, true);
    };

    for (const e of ["pointerdown", "keydown", "touchstart"])
      window.addEventListener(e, finish, true);

    // Also finish after 1s of quiet
    let quietAcc = 0;
    const qt = setInterval(() => {
      if (done) { clearInterval(qt); return; }
      const lag = this.loopLag.max();
      const deltas = this.frameDeltas.values();
      const bad = deltas.length ? deltas.filter(d => d > this.opts.jankThresholdMs).length / deltas.length * 100 : 0;
      const quiet = (isNaN(lag) ? 0 : lag) < 25 && bad < 5;
      quietAcc = quiet ? quietAcc + 250 : 0;
      if (quietAcc >= 1000) { finish(); clearInterval(qt); }
    }, 250);
  }
}
