import { useEffect, useRef } from 'react';
import { prefersReducedMotion } from '../lib/motion.js';

// 16 translucent fish: three loose groups and three loners. They wander, keep a
// little distance from each other and scatter away from the cursor.
export default function FishSchool({ count = 16 }) {
  const ref = useRef(null);
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const cv = ref.current, fx = cv.getContext('2d');
    const size = () => { const r = Math.min(2, devicePixelRatio || 1); cv.width = innerWidth * r; cv.height = innerHeight * r; fx.setTransform(r, 0, 0, r, 0, 0); };
    size(); addEventListener('resize', size);
    let px = -1, py = -1, f = 0, raf;
    const onMove = (e) => { px = e.clientX; py = e.clientY; };
    addEventListener('pointermove', onMove);
    const fish = Array.from({ length: count }, (_, n) => {
      const ang = Math.random() * 6.28;
      return { g: n < 3 ? 3 + n : n % 3, x: innerWidth * Math.random(), y: innerHeight * Math.random(), vx: Math.cos(ang) * 1.5, vy: Math.sin(ang) * 1.5, ph: Math.random() * 6.28, sz: 0.4 + Math.pow(Math.random(), 1.6) * 1.3 };
    });
    const draw = (p, sp) => {
      const L = 48 * p.sz, tw = Math.sin(p.ph) * 0.4, c = Math.cos(tw), s = Math.sin(tw);
      const rx = (x, y) => -0.3 + (x + 0.3) * c - y * s, ry = (x, y) => (x + 0.3) * s + y * c;
      fx.save(); fx.translate(p.x, p.y); fx.rotate(Math.atan2(p.vy, p.vx)); fx.scale(L, L);
      fx.fillStyle = 'rgba(11,42,64,0.26)';
      fx.beginPath(); fx.moveTo(0.5, 0);
      fx.bezierCurveTo(0.46, -0.08, 0.28, -0.12, 0.1, -0.11);
      fx.bezierCurveTo(-0.08, -0.1, -0.2, -0.05, rx(-0.3, -0.025), ry(-0.3, -0.025));
      fx.quadraticCurveTo(rx(-0.4, -0.06), ry(-0.4, -0.06), rx(-0.5, -0.15), ry(-0.5, -0.15));
      fx.quadraticCurveTo(rx(-0.42, 0), ry(-0.42, 0), rx(-0.5, 0.15), ry(-0.5, 0.15));
      fx.quadraticCurveTo(rx(-0.4, 0.06), ry(-0.4, 0.06), rx(-0.3, 0.025), ry(-0.3, 0.025));
      fx.bezierCurveTo(-0.2, 0.05, -0.08, 0.1, 0.1, 0.1);
      fx.bezierCurveTo(0.28, 0.11, 0.46, 0.07, 0.5, 0);
      fx.closePath(); fx.fill(); fx.restore();
    };
    const loop = () => {
      f++; fx.clearRect(0, 0, innerWidth, innerHeight);
      const T = f * 0.0025;
      for (const p of fish) {
        let ax = 0, ay = 0, sx = 0, syy = 0, avx = 0, avy = 0, n = 0;
        for (const o of fish) {
          if (o === p || o.g !== p.g) continue;
          const dx = o.x - p.x, dy = o.y - p.y, dd = dx * dx + dy * dy;
          if (dd < 14400) { n++; sx += o.x; syy += o.y; avx += o.vx; avy += o.vy; if (dd < 1700) { ax -= (dx / (dd + 1)) * 6; ay -= (dy / (dd + 1)) * 6; } }
        }
        if (n) { ax += (sx / n - p.x) * 0.0006 + (avx / n - p.vx) * 0.025; ay += (syy / n - p.y) * 0.0006 + (avy / n - p.vy) * 0.025; }
        const gp = p.g * 2.4;
        const gx = innerWidth * (0.5 + 0.42 * Math.sin(T * (1.1 + p.g * 0.23) + gp)), gy = innerHeight * (0.5 + 0.38 * Math.sin(T * (1.7 + p.g * 0.31) + gp * 1.7));
        ax += (gx - p.x) * 0.0001 + Math.sin(p.ph * 0.05 + p.g) * 0.03; ay += (gy - p.y) * 0.0001 + Math.cos(p.ph * 0.043 + p.g) * 0.03;
        if (px >= 0) { const dx = p.x - px, dy = p.y - py, dd = dx * dx + dy * dy; if (dd < 25000) { const m = ((1 - dd / 25000) * 0.6) / Math.sqrt(dd + 1); ax += dx * m; ay += dy * m; } }
        p.vx += ax; p.vy += ay;
        const sp = Math.hypot(p.vx, p.vy), cl = Math.max(0.8 + 0.4 * p.sz, Math.min(2.2 + 0.6 * p.sz, sp));
        p.vx *= cl / sp; p.vy *= cl / sp; p.x += p.vx; p.y += p.vy; p.ph += 0.18 + sp * 0.06;
        draw(p, sp);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); removeEventListener('resize', size); removeEventListener('pointermove', onMove); };
  }, [count]);
  return <canvas ref={ref} aria-hidden="true" className="pointer-events-none fixed inset-0 z-0 block h-full w-full" />;
}
