import { useEffect, useRef } from 'react';
import { prefersReducedMotion } from '../lib/motion.js';

const TINT = { top: [236, 250, 240], bottom: [120, 214, 200], light: [255, 251, 232], shade: [20, 128, 130] };

// Full-screen ripple simulation. Only the cursor disturbs the water; waves are
// absorbed off-screen (padded grid) so they never bounce back from the edges.
export default function Water({ strength = 1 }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current, ctx = cv.getContext('2d');
    const S = 6, P = 60;
    let W, H, SW, SH, a, b, img, damp, raf;
    const setup = () => {
      W = Math.ceil(innerWidth / S); H = Math.ceil(innerHeight / S); cv.width = W; cv.height = H;
      SW = W + 2 * P; SH = H + 2 * P;
      a = new Float32Array(SW * SH); b = new Float32Array(SW * SH); img = ctx.createImageData(W, H); damp = new Float32Array(SW * SH);
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
    };
    let px = -1, py = -1, cx = -1, cy = -1, boost = 1, sy = scrollY;
    const onMove = (e) => { px = e.clientX; py = e.clientY; if (cx < 0) { cx = px; cy = py; } };
    const onScroll = () => { boost = Math.min(4, boost + Math.abs(scrollY - sy) * 0.02); sy = scrollY; };
    setup();
    addEventListener('resize', setup); addEventListener('pointermove', onMove); addEventListener('scroll', onScroll, { passive: true });
    const still = prefersReducedMotion();
    const row = [], col = [];
    const loop = () => {
      boost += (1 - boost) * 0.04;
      if (!still && cx >= 0) {
        const nx = cx + (px - cx) * 0.08, ny = cy + (py - cy) * 0.08, v = Math.hypot(nx - cx, ny - cy);
        cx = nx; cy = ny;
        if (v > 0.3) drop(cx, cy, Math.round(6 + (boost - 1) * 2), Math.min(10, v * 0.9) * boost * strength);
      }
      for (let y = 1; y < SH - 1; y++) for (let x = 1, i = y * SW + 1; x < SW - 1; x++, i++)
        b[i] = ((a[i - 1] + a[i + 1] + a[i - SW] + a[i + SW]) * 0.5 - b[i]) * damp[i];
      const t = a; a = b; b = t;
      const d = img.data, { top: c0, bottom: c1, light: hl, shade: sh } = TINT;
      for (let x = 0; x < W; x++) col[x] = Math.sin(x * 0.045);
      for (let y = 0; y < H; y++) row[y] = Math.sin(y * 0.06);
      for (let y = 0; y < H; y++) {
        const g = y / H, r0 = c0[0] + (c1[0] - c0[0]) * g, g0 = c0[1] + (c1[1] - c0[1]) * g, b0 = c0[2] + (c1[2] - c0[2]) * g;
        for (let x = 0; x < W; x++) {
          const j = (y + P) * SW + x + P;
          let L = col[x] * row[y] * 0.03 + (a[j - 1] - a[j + 1] + a[j - SW] - a[j + SW]) * 0.012;
          L = L > 0.7 ? 0.7 : L < -0.45 ? -0.45 : L;
          const o = (y * W + x) * 4, tc = L > 0 ? hl : sh, m = Math.abs(L);
          d[o] = r0 + (tc[0] - r0) * m; d[o + 1] = g0 + (tc[1] - g0) * m; d[o + 2] = b0 + (tc[2] - b0) * m; d[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); removeEventListener('resize', setup); removeEventListener('pointermove', onMove); removeEventListener('scroll', onScroll); };
  }, [strength]);
  return <canvas ref={ref} aria-hidden="true" className="pointer-events-none fixed inset-0 z-0 block h-full w-full scale-[1.04] blur-[6px]" />;
}
