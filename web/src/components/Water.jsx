import { useEffect, useRef } from 'react';
import { animate } from '../lib/animation.js';
import { prefersReducedMotion } from '../lib/motion.js';

const TINT = { top: [236, 250, 240], bottom: [120, 214, 200], light: [255, 251, 232], shade: [20, 128, 130] };

// Full-screen ripple simulation. Only the cursor disturbs the water; waves are
// absorbed off-screen (padded grid) so they never bounce back from the edges.
export default function Water({ strength = 1, paused = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current, ctx = cv.getContext('2d');
    const S = 8, P = 40;
    let W, H, SW, SH, a, b, img, px32, damp, row, col, idle = false;
    const setup = () => {
      // At least 1x1: a page loaded hidden (0 wide) would make createImageData throw and blank the app.
      W = Math.max(1, Math.ceil(innerWidth / S)); H = Math.max(1, Math.ceil(innerHeight / S)); cv.width = W; cv.height = H;
      SW = W + 2 * P; SH = H + 2 * P;
      a = new Float32Array(SW * SH); b = new Float32Array(SW * SH); img = ctx.createImageData(W, H); px32 = new Uint32Array(img.data.buffer); damp = new Float32Array(SW * SH);
      col = Float32Array.from({ length: W }, (_, x) => Math.sin(x * 0.045)); row = Float32Array.from({ length: H }, (_, y) => Math.sin(y * 0.06));
      idle = false;
      for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
        const dx = Math.max(0, P - x, x - (P + W - 1)), dy = Math.max(0, P - y, y - (P + H - 1));
        const t = Math.min(1, Math.hypot(dx, dy) / P);
        damp[y * SW + x] = 0.991 * (1 - 0.18 * t * t);
      }
    };
    const drop = (x, y, r, s) => {
      x = (x / S) | 0; y = (y / S) | 0;
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
        if (i * i + j * j > r * r) continue;
        const X = x + i + P, Y = y + j + P;
        if (X > 0 && X < SW - 1 && Y > 0 && Y < SH - 1) a[Y * SW + X] += s * (1 - Math.sqrt(i * i + j * j) / (r + 1));
      }
      idle = false;
    };
    let px = -1, py = -1, cx = -1, cy = -1, boost = 1, sy = scrollY;
    const onMove = (e) => { px = e.clientX; py = e.clientY; if (cx < 0) { cx = px; cy = py; } };
    const onScroll = () => { boost = Math.min(4, boost + Math.abs(scrollY - sy) * 0.02); sy = scrollY; };
    setup();
    // Lets other layers (the beach) read the ripple height at a screen point.
    window.__shoalWater = { sample: (x, y) => { const i = ((y / S) | 0) + P, j = ((x / S) | 0) + P; return i > 0 && i < SH && j > 0 && j < SW ? a[i * SW + j] : 0; } };
    const onResize = () => { setup(); loop(); };
    addEventListener('resize', onResize); addEventListener('pointermove', onMove); addEventListener('scroll', onScroll, { passive: true });
    const still = prefersReducedMotion();
    const loop = () => {
      boost += (1 - boost) * 0.04;
      if (!still && cx >= 0) {
        const nx = cx + (px - cx) * 0.08, ny = cy + (py - cy) * 0.08, v = Math.hypot(nx - cx, ny - cy);
        cx = nx; cy = ny;
        if (v > 0.3) drop(cx, cy, Math.round(6 + (boost - 1) * 2), Math.min(10, v * 0.9) * boost * strength);
      }
      // Flat water is a still picture: skip the simulation and the repaint until the next disturbance.
      if (idle) return;
      let peak = 0;
      for (let y = 1; y < SH - 1; y++) for (let x = 1, i = y * SW + 1; x < SW - 1; x++, i++) {
        const v = ((a[i - 1] + a[i + 1] + a[i - SW] + a[i + SW]) * 0.5 - b[i]) * damp[i];
        b[i] = v; if (v > peak) peak = v; else if (-v > peak) peak = -v;
      }
      const t = a; a = b; b = t;
      // Below this height ripples change the colour by less than one level, so settle them to exactly flat.
      if (peak < 0.3) { a.fill(0); b.fill(0); idle = true; }
      const { top: c0, bottom: c1, light: hl, shade: sh } = TINT;
      for (let y = 0; y < H; y++) {
        const g = y / H, r0 = c0[0] + (c1[0] - c0[0]) * g, g0 = c0[1] + (c1[1] - c0[1]) * g, b0 = c0[2] + (c1[2] - c0[2]) * g;
        for (let x = 0; x < W; x++) {
          const j = (y + P) * SW + x + P;
          let L = col[x] * row[y] * 0.03 + (a[j - 1] - a[j + 1] + a[j - SW] - a[j + SW]) * 0.012;
          L = L > 0.7 ? 0.7 : L < -0.45 ? -0.45 : L;
          const tc = L > 0 ? hl : sh, m = L > 0 ? L : -L;
          px32[y * W + x] = 0xff000000 | (b0 + (tc[2] - b0) * m) << 16 | (g0 + (tc[1] - g0) * m) << 8 | (r0 + (tc[0] - r0) * m);
        }
      }
      ctx.putImageData(img, 0, 0);

    };
    const stop = animate(loop, { paused });
    return () => { stop(); delete window.__shoalWater; removeEventListener('resize', onResize); removeEventListener('pointermove', onMove); removeEventListener('scroll', onScroll); };
  }, [strength, paused]);
  return <canvas ref={ref} aria-hidden="true" className="pointer-events-none fixed inset-0 z-0 block h-full w-full" />;
}
