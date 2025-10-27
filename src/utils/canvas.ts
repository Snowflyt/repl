// Public symbols used across app (e.g., to read back the mirrored context)
export const C2S_SYMBOL = Symbol.for("repl.canvasToSvgCtx");
const STATE_SYMBOL = Symbol.for("repl.canvasMirrorState");
const PATH2D_D_SYMBOL = Symbol.for("repl.path2d.d");
const CANVAS_ID_SYMBOL = Symbol.for("repl.canvasId");
const CTX_ID_SYMBOL = Symbol.for("repl.canvasCtxId");

// Lightweight debug logger (opt-in)
const __C2S_IDS__ = { canvas: 0, ctx: 0 };
const isLogEnabled = (): boolean => {
  try {
    // Global toggle
    // @ts-expect-error runtime flag
    if (typeof window.__REPL_LOG_CANVAS__ !== "undefined") return !!window.__REPL_LOG_CANVAS__;
    const sp = new URLSearchParams(window.location.search);
    if (sp.has("logCanvas")) return sp.get("logCanvas") !== "0";
    if (localStorage.getItem("repl:logCanvas") === "1") return true;
  } catch {
    /* ignore */
  }
  return false;
};
// Avoid overwhelming logs
let LOG_COUNT = 0;
const LOG_LIMIT = 5000;
const safeStr = (v: unknown): unknown => {
  if (typeof v === "string" && v.length > 200) return v.slice(0, 197) + "…";
  return v;
};
const logC2S = (
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D | null,
  msg: string,
  ...args: unknown[]
) => {
  if (!isLogEnabled()) return;
  if (LOG_COUNT++ > LOG_LIMIT) return;
  try {
    const cid = ((canvas as any)[CANVAS_ID_SYMBOL] ?? "?") as number | string;
    const xid = (ctx ? (ctx as any)[CTX_ID_SYMBOL] : "-") as number | string;
    console.debug(`[C2S c#${cid} ctx#${xid}] ${msg}`, ...args.map(safeStr));
  } catch {
    /* ignore */
  }
};
// Expose a runtime toggle helper
try {
  // @ts-expect-error expose helper in window
  if (typeof window.replSetCanvasLog !== "function")
    // @ts-expect-error define function
    window.replSetCanvasLog = (on: boolean) => {
      try {
        // @ts-expect-error: expose debug toggle flag for canvas mirror logging
        window.__REPL_LOG_CANVAS__ = on;
        if (on) LOG_COUNT = 0;
        console.info(`Canvas mirror logging ${on ? "ENABLED" : "DISABLED"}`);
      } catch {
        /* ignore */
      }
    };
} catch {
  /* ignore */
}

type Matrix6 = [number, number, number, number, number, number];
const I: Matrix6 = [1, 0, 0, 1, 0, 0];
const mClone = (m: Matrix6): Matrix6 => m.slice() as Matrix6;
const mMul = (m1: Matrix6, m2: Matrix6): Matrix6 => {
  const [a, b, c, d, e, f] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a * a2 + c * b2,
    b * a2 + d * b2,
    a * c2 + c * d2,
    b * c2 + d * d2,
    a * e2 + c * f2 + e,
    b * e2 + d * f2 + f,
  ];
};
const mTranslate = (tx: number, ty: number): Matrix6 => [1, 0, 0, 1, tx, ty];
const mScale = (sx: number, sy: number): Matrix6 => [sx, 0, 0, sy, 0, 0];
const mRotate = (rad: number): Matrix6 => {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, s, -s, c, 0, 0];
};

interface MirrorState {
  stack: Matrix6[];
  fillStyle?: CanvasRenderingContext2D["fillStyle"];
  strokeStyle?: CanvasRenderingContext2D["strokeStyle"];
  lineWidth: number;
  lineJoin?: CanvasLineJoin;
  lineCap?: CanvasLineCap;
  miterLimit?: number;
  globalAlpha: number;
  currentPathD: string;
  lineDash?: number[];
  lineDashOffset?: number;
  // Track current point for better fidelity with arcTo and continuity
  currentX?: number;
  currentY?: number;
  subpathStartX?: number;
  subpathStartY?: number;
  // Text properties
  font?: string;
  textAlign?: CanvasTextAlign;
  textBaseline?: CanvasTextBaseline;
  // SVG structure
  svg: SVGSVGElement;
  defs: SVGDefsElement;
  currentGroup: SVGGElement;
  groupStack: SVGGElement[];
  idCounter: number;
}

/**
 * Install a monkey patch that mirrors 2D canvas drawing to an SVG context (canvas-to-svg).
 * Safe to call multiple times.
 * @returns A restore function to remove the patch.
 */
export function installCanvasSvgMirroring(): () => void {
  const CanvasProto = HTMLCanvasElement.prototype as unknown as {
    getContext: (type: string, ...args: unknown[]) => any;
  };
  const originalGetContext = CanvasProto.getContext;
  const OriginalPath2D = window.Path2D;
  const PROXY_MAP = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();

  // Tag Path2D(d) with its d attribute so we can emit <path d="...">
  const PatchedPath2D = function Path2DPatched(arg?: string | Path2D) {
    const p = arg === undefined ? new OriginalPath2D() : new OriginalPath2D(arg as any);
    if (typeof arg === "string")
      try {
        Object.defineProperty(p as any, PATH2D_D_SYMBOL, { value: arg, enumerable: false });
      } catch (e) {
        (p as any)[PATH2D_D_SYMBOL] = arg;
      }
    try {
      if (isLogEnabled()) {
        const info = typeof arg === "string" ? { dLen: arg.length } : { from: typeof arg };
        console.debug(`[C2S Path2D] constructed`, info);
      }
    } catch {
      /* ignore */
    }
    return p;
  } as unknown as typeof Path2D;
  PatchedPath2D.prototype = OriginalPath2D.prototype;
  window.Path2D = PatchedPath2D;

  const ensureSvgRoot = (canvas: HTMLCanvasElement) => {
    let svg = (canvas as any)[C2S_SYMBOL] as SVGSVGElement | undefined;
    if (!svg) {
      const w = canvas.width || canvas.clientWidth || 300;
      const h = canvas.height || canvas.clientHeight || 150;
      const ns = "http://www.w3.org/2000/svg";
      svg = document.createElementNS(ns, "svg");
      svg.setAttribute("xmlns", ns);
      svg.setAttribute("width", String(w));
      svg.setAttribute("height", String(h));
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      (canvas as any)[C2S_SYMBOL] = svg;
    }
    return svg;
  };

  CanvasProto.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
    const realCtx = originalGetContext.apply(this, [type, ...args]);
    if (type !== "2d" || !realCtx) return realCtx;

    const existing = PROXY_MAP.get(this);
    if (existing) return existing as unknown as CanvasRenderingContext2D;

    // Ensure we have an SVG root to append captured paths
    const svgRoot = ensureSvgRoot(this);
    // Assign IDs for logging
    if (Reflect.get(this, CANVAS_ID_SYMBOL) == null) {
      Reflect.set(this, CANVAS_ID_SYMBOL, ++__C2S_IDS__.canvas);
    }
    if (Reflect.get(realCtx as object, CTX_ID_SYMBOL) == null) {
      Reflect.set(realCtx as object, CTX_ID_SYMBOL, ++__C2S_IDS__.ctx);
    }
    logC2S(this, realCtx, `getContext('2d')`, { args });
    // Ensure <defs> and a root content group <g>
    const ns = "http://www.w3.org/2000/svg";
    let defs = svgRoot.querySelector<SVGDefsElement>("defs");
    if (!defs) {
      defs = document.createElementNS(ns, "defs");
      svgRoot.appendChild(defs);
    }
    const baseGroup = svgRoot.querySelector("g[data-root-content]");
    let baseGroupEl: SVGGElement;
    if (baseGroup instanceof SVGGElement) baseGroupEl = baseGroup;
    else {
      baseGroupEl = document.createElementNS(ns, "g");
      baseGroupEl.setAttribute("data-root-content", "true");
      svgRoot.appendChild(baseGroupEl);
    }
    const state: MirrorState = {
      stack: [mClone(I)],
      lineWidth: 1,
      globalAlpha: 1,
      currentPathD: "",
      svg: svgRoot,
      defs,
      currentGroup: baseGroupEl,
      groupStack: [],
      idCounter: 0,
    };
    (this as any)[STATE_SYMBOL] = state;
    // Record the canvas element on state for logging use in wrappers
    (state as any).canvas = this;

    const appendPathD = (d: string, kind: "fill" | "stroke", fillRule?: CanvasFillRule) => {
      try {
        const svg = state.currentGroup;
        const path = document.createElementNS(ns, "path");
        path.setAttribute("d", d);
        const fs = state.fillStyle;
        const ss = state.strokeStyle;
        const lw = state.lineWidth;
        const alpha = state.globalAlpha;
        if (kind === "fill") {
          if (typeof fs === "string") path.setAttribute("fill", fs);
          else path.setAttribute("fill", "currentColor");
          if (fillRule === "evenodd") path.setAttribute("fill-rule", "evenodd");
        } else {
          path.setAttribute("fill", "none");
          if (typeof ss === "string") path.setAttribute("stroke", ss);
          path.setAttribute("stroke-width", String(lw));
          if (state.lineDash && state.lineDash.length > 0)
            path.setAttribute("stroke-dasharray", state.lineDash.join(","));
          if (state.lineDashOffset)
            path.setAttribute("stroke-dashoffset", String(state.lineDashOffset));
        }
        if (state.lineJoin) path.setAttribute("stroke-linejoin", state.lineJoin);
        if (state.lineCap) path.setAttribute("stroke-linecap", state.lineCap);
        if (state.miterLimit != null)
          path.setAttribute("stroke-miterlimit", String(state.miterLimit));
        if (alpha < 1) path.setAttribute("opacity", String(alpha));
        const m = state.stack[state.stack.length - 1]!;
        if (!(m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0))
          path.setAttribute("transform", `matrix(${m[0]} ${m[1]} ${m[2]} ${m[3]} ${m[4]} ${m[5]})`);
        svg.appendChild(path);
      } catch (e) {
        // Ignore
      }
    };

    const appendClipFromPathD = (d: string, fillRule?: CanvasFillRule) => {
      try {
        const id = `clip_${++state.idCounter}`;
        const cp = document.createElementNS(ns, "clipPath");
        cp.setAttribute("id", id);
        const p = document.createElementNS(ns, "path");
        p.setAttribute("d", d);
        if (fillRule === "evenodd") p.setAttribute("clip-rule", "evenodd");
        const m = state.stack[state.stack.length - 1]!;
        if (!(m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0))
          p.setAttribute("transform", `matrix(${m[0]} ${m[1]} ${m[2]} ${m[3]} ${m[4]} ${m[5]})`);
        cp.appendChild(p);
        state.defs.appendChild(cp);
        // Nest a new group with this clip-path
        const g = document.createElementNS(ns, "g");
        g.setAttribute("clip-path", `url(#${id})`);
        state.currentGroup.appendChild(g);
        state.currentGroup = g;
      } catch (e) {
        // Ignore
      }
    };

    const handler: ProxyHandler<any> = {
      get(target, prop) {
        // IMPORTANT: don't pass the Proxy as the receiver to DOM accessors like lineWidth.
        // Many CanvasRenderingContext2D getters/setters are WebIDL accessors that verify
        // the "this" value is the native CanvasRenderingContext2D.
        const v = Reflect.get(target, prop);
        if (typeof v === "function") {
          if (prop === "beginPath") {
            return () => {
              state.currentPathD = "";
              state.currentX = undefined;
              state.currentY = undefined;
              state.subpathStartX = undefined;
              state.subpathStartY = undefined;
              return v.apply(target, []);
            };
          }
          if (prop === "closePath") {
            return () => {
              state.currentPathD += " Z";
              // After closePath, current point becomes the start point of the subpath
              state.currentX = state.subpathStartX;
              state.currentY = state.subpathStartY;
              return v.apply(target, []);
            };
          }
          if (prop === "moveTo") {
            return (x: number, y: number) => {
              state.currentPathD += ` M ${x} ${y}`;
              state.currentX = x;
              state.currentY = y;
              state.subpathStartX = x;
              state.subpathStartY = y;
              return v.apply(target, [x, y]);
            };
          }
          if (prop === "lineTo") {
            return (x: number, y: number) => {
              state.currentPathD += ` L ${x} ${y}`;
              state.currentX = x;
              state.currentY = y;
              return v.apply(target, [x, y]);
            };
          }
          if (prop === "bezierCurveTo") {
            return (
              cp1x: number,
              cp1y: number,
              cp2x: number,
              cp2y: number,
              x: number,
              y: number,
            ) => {
              state.currentPathD += ` C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${x} ${y}`;
              state.currentX = x;
              state.currentY = y;
              return v.apply(target, [cp1x, cp1y, cp2x, cp2y, x, y]);
            };
          }
          if (prop === "quadraticCurveTo") {
            return (cpx: number, cpy: number, x: number, y: number) => {
              state.currentPathD += ` Q ${cpx} ${cpy} ${x} ${y}`;
              state.currentX = x;
              state.currentY = y;
              return v.apply(target, [cpx, cpy, x, y]);
            };
          }
          if (prop === "rect") {
            return (x: number, y: number, w: number, h: number) => {
              // Draw rect path into current path
              const x2 = x + w;
              const y2 = y + h;
              state.currentPathD += ` M ${x} ${y} L ${x2} ${y} L ${x2} ${y2} L ${x} ${y2} Z`;
              state.currentX = x;
              state.currentY = y;
              state.subpathStartX = x;
              state.subpathStartY = y;
              return v.apply(target, [x, y, w, h]);
            };
          }
          if (prop === "roundRect") {
            return (x: number, y: number, w: number, h: number, radii?: number | number[]) => {
              const clamp = (val: number) => Math.max(0, val);
              const minSide = Math.min(Math.abs(w), Math.abs(h));
              const norm = (r: number | number[] | undefined): [number, number, number, number] => {
                if (r == null) return [0, 0, 0, 0];
                if (typeof r === "number") return [r, r, r, r];
                const arr = r.slice(0, 4);
                if (arr.length === 1) return [arr[0]!, arr[0]!, arr[0]!, arr[0]!];
                if (arr.length === 2) return [arr[0]!, arr[1]!, arr[0]!, arr[1]!];
                if (arr.length === 3) return [arr[0]!, arr[1]!, arr[2]!, arr[1]!];
                return [arr[0]!, arr[1]!, arr[2]!, arr[3]!];
              };
              let [rtl, rtr, rbr, rbl] = norm(radii);
              const cap = minSide / 2;
              rtl = clamp(Math.min(rtl, cap));
              rtr = clamp(Math.min(rtr, cap));
              rbr = clamp(Math.min(rbr, cap));
              rbl = clamp(Math.min(rbl, cap));
              const x2 = x + w;
              const y2 = y + h;
              // Path clockwise starting from top-left corner tangency point
              state.currentPathD += ` M ${x + rtl} ${y}`;
              state.currentPathD += ` L ${x2 - rtr} ${y}`;
              if (rtr > 0) state.currentPathD += ` A ${rtr} ${rtr} 0 0 1 ${x2} ${y + rtr}`;
              state.currentPathD += ` L ${x2} ${y2 - rbr}`;
              if (rbr > 0) state.currentPathD += ` A ${rbr} ${rbr} 0 0 1 ${x2 - rbr} ${y2}`;
              state.currentPathD += ` L ${x + rbl} ${y2}`;
              if (rbl > 0) state.currentPathD += ` A ${rbl} ${rbl} 0 0 1 ${x} ${y2 - rbl}`;
              state.currentPathD += ` L ${x} ${y + rtl}`;
              if (rtl > 0) state.currentPathD += ` A ${rtl} ${rtl} 0 0 1 ${x + rtl} ${y}`;
              state.currentPathD += ` Z`;
              // Update current point semantics like canvas: after a closed subpath, current point becomes subpath start
              state.subpathStartX = x + rtl;
              state.subpathStartY = y;
              state.currentX = state.subpathStartX;
              state.currentY = state.subpathStartY;
              return v.apply(target, [x, y, w, h, radii as any]);
            };
          }
          if (prop === "ellipse") {
            return (
              cx: number,
              cy: number,
              rx: number,
              ry: number,
              rotation: number,
              startAngle: number,
              endAngle: number,
              anticlockwise = false,
            ) => {
              logC2S((state as any).canvas, target, "ellipse()", {
                cx,
                cy,
                rx,
                ry,
                rotation,
                startAngle,
                endAngle,
                anticlockwise,
              });
              // Normalize angles
              const sa = startAngle;
              const ea = endAngle;
              const twoPi = Math.PI * 2;
              const rawDelta = ea - sa;
              const delta = ((rawDelta % twoPi) + twoPi) % twoPi;
              const sweep = anticlockwise ? -1 : 1;
              const useDelta = delta === 0 ? twoPi : delta; // treat 0 as full circle
              // Compute start/end points in local coords (pre-transform)
              const cosRot = Math.cos(rotation);
              const sinRot = Math.sin(rotation);
              const sx = cx + rx * Math.cos(sa) * cosRot - ry * Math.sin(sa) * sinRot;
              const sy = cy + rx * Math.cos(sa) * sinRot + ry * Math.sin(sa) * cosRot;
              const exx = Math.cos(ea);
              const eyy = Math.sin(ea);
              const ex = cx + rx * exx * cosRot - ry * eyy * sinRot;
              const ey = cy + rx * exx * sinRot + ry * eyy * cosRot;
              const isFull = Math.abs(useDelta - twoPi) < 1e-9;
              const sweepFlag = sweep > 0 ? 1 : 0;
              // Prefer continuity: if we have a current point, connect with line; otherwise move
              const startingNew = state.currentX == null || state.currentY == null;
              if (startingNew) {
                state.currentPathD += ` M ${sx} ${sy}`;
                state.subpathStartX = sx;
                state.subpathStartY = sy;
              } else state.currentPathD += ` L ${sx} ${sy}`;
              if (isFull) {
                // Split into two half-arcs to represent a full ellipse, then close
                const mid = sa + (sweep > 0 ? Math.PI : -Math.PI);
                const mx = cx + rx * Math.cos(mid) * cosRot - ry * Math.sin(mid) * sinRot;
                const my = cy + rx * Math.cos(mid) * sinRot + ry * Math.sin(mid) * cosRot;
                state.currentPathD += ` A ${rx} ${ry} ${(rotation * 180) / Math.PI} 0 ${sweepFlag} ${mx} ${my}`;
                state.currentPathD += ` A ${rx} ${ry} ${(rotation * 180) / Math.PI} 0 ${sweepFlag} ${ex} ${ey}`;
                state.currentPathD += ` Z`;
                // After closing, current point becomes subpath start
                state.currentX = state.subpathStartX;
                state.currentY = state.subpathStartY;
              } else {
                const largeArcFlag = useDelta > Math.PI ? 1 : 0;
                state.currentPathD += ` A ${rx} ${ry} ${(rotation * 180) / Math.PI} ${largeArcFlag} ${sweepFlag} ${ex} ${ey}`;
                state.currentX = ex;
                state.currentY = ey;
              }
              return v.apply(target, [cx, cy, rx, ry, rotation, sa, ea, anticlockwise]);
            };
          }
          if (prop === "arc") {
            return (
              cx: number,
              cy: number,
              r: number,
              startAngle: number,
              endAngle: number,
              anticlockwise = false,
            ) => {
              logC2S((state as any).canvas, target, "arc()", {
                cx,
                cy,
                r,
                startAngle,
                endAngle,
                anticlockwise,
              });
              const sa = startAngle;
              const ea = endAngle;
              const twoPi = Math.PI * 2;
              const rawDelta = ea - sa;
              const delta = ((rawDelta % twoPi) + twoPi) % twoPi;
              const sweep = anticlockwise ? -1 : 1;
              const useDelta = delta === 0 ? twoPi : delta;
              const sx = cx + r * Math.cos(sa);
              const sy = cy + r * Math.sin(sa);
              const ex = cx + r * Math.cos(ea);
              const ey = cy + r * Math.sin(ea);
              const isFull = Math.abs(useDelta - twoPi) < 1e-9;
              const sweepFlag = sweep > 0 ? 1 : 0;
              const startingNew = state.currentX == null || state.currentY == null;
              if (startingNew) {
                state.currentPathD += ` M ${sx} ${sy}`;
                state.subpathStartX = sx;
                state.subpathStartY = sy;
              } else state.currentPathD += ` L ${sx} ${sy}`;
              if (isFull) {
                const mid = sa + (sweep > 0 ? Math.PI : -Math.PI);
                const mx = cx + r * Math.cos(mid);
                const my = cy + r * Math.sin(mid);
                state.currentPathD += ` A ${r} ${r} 0 0 ${sweepFlag} ${mx} ${my}`;
                state.currentPathD += ` A ${r} ${r} 0 0 ${sweepFlag} ${ex} ${ey}`;
                state.currentPathD += ` Z`;
                state.currentX = state.subpathStartX;
                state.currentY = state.subpathStartY;
              } else {
                const largeArcFlag = useDelta > Math.PI ? 1 : 0;
                state.currentPathD += ` A ${r} ${r} 0 ${largeArcFlag} ${sweepFlag} ${ex} ${ey}`;
                state.currentX = ex;
                state.currentY = ey;
              }
              return v.apply(target, [cx, cy, r, startAngle, endAngle, anticlockwise]);
            };
          }
          if (prop === "clip") {
            return (...a: any[]) => {
              try {
                const p0 = a[0];
                let fillRuleArg: CanvasFillRule | undefined = undefined;
                let d: string | null = null;
                if (p0 && typeof p0 === "object" && PATH2D_D_SYMBOL in p0) {
                  const dd = (p0 as Record<PropertyKey, unknown>)[
                    PATH2D_D_SYMBOL as unknown as keyof typeof p0
                  ];
                  if (typeof dd === "string") d = dd;
                  if (typeof a[1] === "string") fillRuleArg = a[1] as CanvasFillRule;
                } else {
                  if (typeof p0 === "string") fillRuleArg = p0 as CanvasFillRule;
                  if (state.currentPathD) d = state.currentPathD;
                }
                logC2S((state as any).canvas, target, "clip()", {
                  hasPath2D: !!(p0 && typeof p0 === "object" && PATH2D_D_SYMBOL in p0),
                  fillRule: fillRuleArg,
                });
                if (d) appendClipFromPathD(d, fillRuleArg);
              } catch (e) {
                // Ignore
              }
              return v.apply(target, a);
            };
          }
          if (prop === "arcTo") {
            return (x1: number, y1: number, x2: number, y2: number, radius: number) => {
              logC2S((state as any).canvas, target, "arcTo()", { x1, y1, x2, y2, radius });
              // Low-risk approximation: if no current point, move to (x1,y1) then draw a line to (x2,y2)
              // Otherwise, approximate arc tangent between segments with a simple corner arc of given radius.
              const cx = state.currentX;
              const cy = state.currentY;
              if (cx == null || cy == null || radius <= 0) {
                // Degrade gracefully
                state.currentPathD += ` M ${x1} ${y1} L ${x2} ${y2}`;
                state.currentX = x2;
                state.currentY = y2;
                return v.apply(target, [x1, y1, x2, y2, radius]);
              }
              // Vectors
              const v1x = cx - x1;
              const v1y = cy - y1;
              const v2x = x2 - x1;
              const v2y = y2 - y1;
              const len1 = Math.hypot(v1x, v1y) || 1;
              const len2 = Math.hypot(v2x, v2y) || 1;
              const n1x = v1x / len1;
              const n1y = v1y / len1;
              const n2x = v2x / len2;
              const n2y = v2y / len2;
              // Angle between vectors
              const dot = n1x * n2x + n1y * n2y;
              const clamped = Math.min(1, Math.max(-1, dot));
              const angle = Math.acos(clamped);
              // Distance from corner to tangent points
              const t = radius / Math.tan(angle / 2);
              // Tangent points along each segment
              const p1x = x1 + n1x * t;
              const p1y = y1 + n1y * t;
              const p2x = x1 + n2x * t;
              const p2y = y1 + n2y * t;
              // Join with arc of given radius
              state.currentPathD += ` L ${p1x} ${p1y}`;
              // Arc from p1 to p2 with radius, choose flags to represent a small arc
              const sweepFlag = n1x * n2y - n1y * n2x < 0 ? 1 : 0; // flip orientation to match canvas
              state.currentPathD += ` A ${radius} ${radius} 0 0 ${sweepFlag} ${p2x} ${p2y}`;
              state.currentX = p2x;
              state.currentY = p2y;
              return v.apply(target, [x1, y1, x2, y2, radius]);
            };
          }
          if (prop === "fillRect") {
            return (x: number, y: number, w: number, h: number) => {
              logC2S((state as any).canvas, target, "fillRect()", { x, y, w, h });
              const x2 = x + w;
              const y2 = y + h;
              const d = `M ${x} ${y} L ${x2} ${y} L ${x2} ${y2} L ${x} ${y2} Z`;
              appendPathD(d, "fill");
              return v.apply(target, [x, y, w, h]);
            };
          }
          if (prop === "strokeRect") {
            return (x: number, y: number, w: number, h: number) => {
              logC2S((state as any).canvas, target, "strokeRect()", { x, y, w, h });
              const x2 = x + w;
              const y2 = y + h;
              const d = `M ${x} ${y} L ${x2} ${y} L ${x2} ${y2} L ${x} ${y2} Z`;
              appendPathD(d, "stroke");
              return v.apply(target, [x, y, w, h]);
            };
          }
          if (prop === "setLineDash") {
            return (segments: number[]) => {
              try {
                state.lineDash = Array.isArray(segments) ? segments.slice() : [];
              } catch (e) {
                // Ignore
              }
              logC2S((state as any).canvas, target, "setLineDash()", { segments });
              return v.apply(target, [segments]);
            };
          }
          if (prop === "fillText") {
            return (text: string, x: number, y: number, maxWidth?: number) => {
              logC2S((state as any).canvas, target, "fillText()", {
                text: safeStr(text),
                x,
                y,
                maxWidth,
              });
              try {
                const ns = "http://www.w3.org/2000/svg";
                const textEl = document.createElementNS(ns, "text");
                textEl.textContent = text;
                textEl.setAttribute("x", String(x));
                textEl.setAttribute("y", String(y));
                // Font and alignment
                if (state.font) textEl.setAttribute("style", `font: ${state.font}`);
                const anchorMap: Record<CanvasTextAlign, string> = {
                  start: "start",
                  end: "end",
                  left: "start",
                  right: "end",
                  center: "middle",
                };
                const baselineMap: Partial<Record<CanvasTextBaseline, string>> = {
                  alphabetic: "alphabetic",
                  top: "text-before-edge",
                  hanging: "hanging",
                  middle: "middle",
                  ideographic: "ideographic",
                  bottom: "text-after-edge",
                };
                const ta = state.textAlign ?? "start";
                textEl.setAttribute("text-anchor", anchorMap[ta]);
                const tb = state.textBaseline ?? "alphabetic";
                const db = baselineMap[tb] ?? "alphabetic";
                textEl.setAttribute("dominant-baseline", db);
                // Fill style
                const fs = state.fillStyle;
                if (typeof fs === "string") textEl.setAttribute("fill", fs);
                if (state.globalAlpha < 1)
                  textEl.setAttribute("opacity", String(state.globalAlpha));
                // Transform
                const m = state.stack[state.stack.length - 1]!;
                if (
                  !(
                    m[0] === 1 &&
                    m[1] === 0 &&
                    m[2] === 0 &&
                    m[3] === 1 &&
                    m[4] === 0 &&
                    m[5] === 0
                  )
                )
                  textEl.setAttribute(
                    "transform",
                    `matrix(${m[0]} ${m[1]} ${m[2]} ${m[3]} ${m[4]} ${m[5]})`,
                  );
                state.currentGroup.appendChild(textEl);
              } catch (e) {
                // Ignore
              }
              return v.apply(target, [text, x, y, maxWidth]);
            };
          }
          if (prop === "strokeText") {
            return (text: string, x: number, y: number, maxWidth?: number) => {
              logC2S((state as any).canvas, target, "strokeText()", {
                text: safeStr(text),
                x,
                y,
                maxWidth,
              });
              try {
                const ns = "http://www.w3.org/2000/svg";
                const textEl = document.createElementNS(ns, "text");
                textEl.textContent = text;
                textEl.setAttribute("x", String(x));
                textEl.setAttribute("y", String(y));
                if (state.font) textEl.setAttribute("style", `font: ${state.font}`);
                const anchorMap: Record<CanvasTextAlign, string> = {
                  start: "start",
                  end: "end",
                  left: "start",
                  right: "end",
                  center: "middle",
                };
                const baselineMap: Partial<Record<CanvasTextBaseline, string>> = {
                  alphabetic: "alphabetic",
                  top: "text-before-edge",
                  hanging: "hanging",
                  middle: "middle",
                  ideographic: "ideographic",
                  bottom: "text-after-edge",
                };
                const ta = state.textAlign ?? "start";
                textEl.setAttribute("text-anchor", anchorMap[ta]);
                const tb = state.textBaseline ?? "alphabetic";
                const db = baselineMap[tb] ?? "alphabetic";
                textEl.setAttribute("dominant-baseline", db);
                const ss = state.strokeStyle;
                if (typeof ss === "string") textEl.setAttribute("stroke", ss);
                textEl.setAttribute("fill", "none");
                textEl.setAttribute("stroke-width", String(state.lineWidth));
                if (state.lineDash && state.lineDash.length > 0)
                  textEl.setAttribute("stroke-dasharray", state.lineDash.join(","));
                if (state.lineDashOffset)
                  textEl.setAttribute("stroke-dashoffset", String(state.lineDashOffset));
                if (state.globalAlpha < 1)
                  textEl.setAttribute("opacity", String(state.globalAlpha));
                const m = state.stack[state.stack.length - 1]!;
                if (
                  !(
                    m[0] === 1 &&
                    m[1] === 0 &&
                    m[2] === 0 &&
                    m[3] === 1 &&
                    m[4] === 0 &&
                    m[5] === 0
                  )
                )
                  textEl.setAttribute(
                    "transform",
                    `matrix(${m[0]} ${m[1]} ${m[2]} ${m[3]} ${m[4]} ${m[5]})`,
                  );
                state.currentGroup.appendChild(textEl);
              } catch (e) {
                // Ignore
              }
              return v.apply(target, [text, x, y, maxWidth]);
            };
          }
          if (prop === "save") {
            return () => {
              logC2S((state as any).canvas, target, "save()");
              state.stack.push(mClone(state.stack[state.stack.length - 1]!));
              state.groupStack.push(state.currentGroup);
              return v.apply(target, []);
            };
          }
          if (prop === "restore") {
            return () => {
              logC2S((state as any).canvas, target, "restore()");
              if (state.stack.length > 1) state.stack.pop();
              if (state.groupStack.length > 0) state.currentGroup = state.groupStack.pop()!;
              return v.apply(target, []);
            };
          }
          if (prop === "resetTransform") {
            return () => {
              logC2S((state as any).canvas, target, "resetTransform()");
              state.stack[state.stack.length - 1] = mClone(I);
              return v.apply(target, []);
            };
          }
          if (prop === "translate") {
            return (tx: number, ty: number) => {
              logC2S((state as any).canvas, target, "translate()", { tx, ty });
              state.stack[state.stack.length - 1] = mMul(
                state.stack[state.stack.length - 1]!,
                mTranslate(tx, ty),
              );
              return v.apply(target, [tx, ty]);
            };
          }
          if (prop === "scale") {
            return (sx: number, sy: number) => {
              logC2S((state as any).canvas, target, "scale()", { sx, sy });
              state.stack[state.stack.length - 1] = mMul(
                state.stack[state.stack.length - 1]!,
                mScale(sx, sy),
              );
              return v.apply(target, [sx, sy]);
            };
          }
          if (prop === "rotate") {
            return (rad: number) => {
              logC2S((state as any).canvas, target, "rotate()", { rad });
              state.stack[state.stack.length - 1] = mMul(
                state.stack[state.stack.length - 1]!,
                mRotate(rad),
              );
              return v.apply(target, [rad]);
            };
          }
          if (prop === "transform") {
            return (a: number, b: number, c: number, d: number, e: number, f: number) => {
              logC2S((state as any).canvas, target, "transform()", { a, b, c, d, e, f });
              state.stack[state.stack.length - 1] = mMul(state.stack[state.stack.length - 1]!, [
                a,
                b,
                c,
                d,
                e,
                f,
              ]);
              return v.apply(target, [a, b, c, d, e, f]);
            };
          }
          if (prop === "setTransform") {
            return (...a: any[]) => {
              logC2S((state as any).canvas, target, "setTransform()", { args: a });
              if (a.length === 6) {
                const m: Matrix6 = [a[0], a[1], a[2], a[3], a[4], a[5]];
                state.stack[state.stack.length - 1] = m;
              } else {
                state.stack[state.stack.length - 1] = mClone(I);
              }
              return v.apply(target, a);
            };
          }

          if (prop === "fill" || prop === "stroke") {
            const kind = prop;
            return (...a: any[]) => {
              try {
                const p0 = a[0];
                // Extract optional fillRule from args
                let fillRuleArg: CanvasFillRule | undefined = undefined;
                if (kind === "fill") {
                  if (typeof p0 === "string") fillRuleArg = p0 as CanvasFillRule;
                  else if (typeof a[1] === "string") fillRuleArg = a[1] as CanvasFillRule;
                }
                logC2S((state as any).canvas, target, `${kind}()`, {
                  hasPath2D: !!(p0 && typeof p0 === "object" && PATH2D_D_SYMBOL in p0),
                  fillRule: fillRuleArg,
                  pathLen: state.currentPathD.length,
                });
                if (p0 && typeof p0 === "object" && PATH2D_D_SYMBOL in p0) {
                  const d = (p0 as Record<PropertyKey, unknown>)[
                    PATH2D_D_SYMBOL as unknown as keyof typeof p0
                  ];
                  if (typeof d === "string") appendPathD(d, kind, fillRuleArg);
                } else if (state.currentPathD) {
                  appendPathD(state.currentPathD, kind, fillRuleArg);
                }
              } catch (e) {
                // Ignore
              }
              return v.apply(target, a);
            };
          }
          // Default: do not mirror to SVG, just call real canvas
          return (...a: any[]) => v.apply(target, a);
        }
        return v;
      },
      set(target, prop, value) {
        try {
          const st = state as any;
          if (prop === "fillStyle") st.fillStyle = value;
          else if (prop === "strokeStyle") st.strokeStyle = value;
          else if (prop === "lineWidth") st.lineWidth = Number(value);
          else if (prop === "lineJoin") st.lineJoin = value;
          else if (prop === "lineCap") st.lineCap = value;
          else if (prop === "miterLimit") st.miterLimit = Number(value);
          else if (prop === "globalAlpha") st.globalAlpha = Number(value);
          else if (prop === "lineDashOffset") st.lineDashOffset = Number(value);
          else if (prop === "font") st.font = String(value);
          else if (prop === "textAlign") st.textAlign = value as CanvasTextAlign;
          else if (prop === "textBaseline") st.textBaseline = value as CanvasTextBaseline;
          logC2S((state as any).canvas, target, `set ${String(prop)}`, { value: safeStr(value) });
        } catch (e) {
          // Ignore
        }
        // Important: call setter on the real context to avoid "does not implement CanvasRenderingContext2D" errors
        try {
          // Direct assignment ensures correct 'this' for platform setters
          (target as Record<PropertyKey, unknown>)[prop as unknown as keyof typeof target] = value;
          return true;
        } catch (e) {
          return Reflect.set(target, prop, value);
        }
      },
    };

    const proxy = new Proxy(realCtx, handler) as CanvasRenderingContext2D;
    PROXY_MAP.set(this, proxy);
    return proxy;
  } as typeof CanvasProto.getContext;

  return function restoreCanvasSvgMirroring() {
    CanvasProto.getContext = originalGetContext;
    try {
      window.Path2D = OriginalPath2D;
    } catch (e) {
      // Ignore
    }
  };
}
