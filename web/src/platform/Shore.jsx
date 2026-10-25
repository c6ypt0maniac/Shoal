import { useEffect, useRef } from 'react';
import { prefersReducedMotion } from '../lib/motion.js';

// The sidebar is the beach. Waves arrive in irregular sets: a foam roll breaks
// offshore, runs up the sand in uneven lobes, slides back leaving a lace line
// at its highest reach, and the sand it wet slowly dries. Cursor ripples that
// reach the shore nudge the waterline too.
const rand = (a, b) => a + Math.random() * (b - a);
const ease = (p) => 1 - Math.pow(1 - p, 3);
const easeIO = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

export default function Shore({ width = 300 }) {
  const r = { sand: useRef(null), wet: useRef(null), glow: useRef(null), foam: useRef(null), film: useRef(null), breaker: useRef(null), lace0: useRef(null), lace1: useRef(null) };
  useEffect(() => {
    // Barely-there lapping, close to the original still shoreline; fully
    // still for people who prefer reduced motion.
    const STEP = 8, BASE = width + 72, still = prefersReducedMotion();
    let raf, waves = [], next = 0, setLeft = 0, wet = [], push = [], raw = [];
    const spawn = (t) => {
      // Sets: 2-4 bigger waves, then a lull of smaller ones.
      if (setLeft <= 0) setLeft = Math.round(rand(2, 4));
      const big = setLeft-- > 0 && Math.random() < 0.75;
      const A = big ? rand(6, 10) : rand(3, 6);
      waves.push({ t0: t, A, ap: rand(0.9, 1.3), up: rand(1.4, 2.1) * (A / 60) ** 0.4, down: rand(2.6, 3.6), l: [[rand(0.18, 0.32), rand(0.006, 0.011), rand(0, 6.3)], [rand(0.1, 0.2), rand(0.018, 0.03), rand(0, 6.3)], [rand(0.04, 0.08), rand(0.05, 0.08), rand(0, 6.3)]], peak: null, slot: waves.length % 2 });
      next = t + (big ? rand(7, 10) : rand(8, 12));
    };
    const lobes = (w, y) => w.l.reduce((s, [a, f, p]) => s + a * Math.sin(y * f + p), 0);
    const pathOf = (xs) => xs.map((x, i) => (i ? 'L' : 'M') + x.toFixed(1) + ' ' + (i * STEP - STEP)).join('');
    const frame = (now) => {
      const t = now / 1000, H = innerHeight, n = Math.ceil(H / STEP) + 3;
      if (!still && t >= next) spawn(t);
      const line = new Array(n), brk = new Array(n);
      let energy = 0, film = 0, bOp = 0;
      for (let i = 0; i < n; i++) { const y = i * STEP - STEP; line[i] = BASE + 4 * Math.sin(y * 0.012 + t * 0.25); brk[i] = null; }
      const lace = [null, null], laceOp = [0, 0];
      waves = waves.filter((w) => t - w.t0 < w.ap + w.up + w.down + 3);
      for (const w of waves) {
        const k = t - w.t0;
        let reach = 0;
        if (k < w.ap) {
          const p = k / w.ap, op = Math.sin(Math.PI * Math.min(1, p * 1.1)) * Math.min(1, w.A / 50);
          if (op > bOp) { bOp = op; for (let i = 0; i < n; i++) { const y = i * STEP - STEP; brk[i] = BASE + 18 + 120 * (1 - ease(p)) + 10 * lobes(w, y * 0.7); } }
          continue;
        } else if (k < w.ap + w.up) { const p = (k - w.ap) / w.up; reach = ease(p); energy = Math.max(energy, 1 - p * 0.6); }
        else if (k < w.ap + w.up + w.down) { const p = (k - w.ap - w.up) / w.down; reach = 1 - easeIO(p); film = Math.max(film, 1 - p); if (!w.peak) w.peak = line.map((_, i) => BASE - w.A * (1 + lobes(w, i * STEP - STEP))); laceOp[w.slot] = Math.max(laceOp[w.slot], 0.75 * (1 - p * 0.5)); lace[w.slot] = w.peak; }
        else { const p = (k - w.ap - w.up - w.down) / 3; if (w.peak) { lace[w.slot] = w.peak; laceOp[w.slot] = Math.max(laceOp[w.slot], 0.38 * (1 - p)); } continue; }
        for (let i = 0; i < n; i++) { const x = BASE - w.A * reach * (1 + lobes(w, i * STEP - STEP)); if (x < line[i]) line[i] = x; }
      }
      const water = null;
      for (let i = 0; i < n; i++) {
        const y = i * STEP - STEP;
        if (water) {
          // The ripple field flips sign cell to cell, so average a wide patch and ease in slowly.
          let h = 0; for (let dx = 12; dx <= 60; dx += 12) for (let dy = -24; dy <= 24; dy += 12) h += water.sample(line[i] + dx, y + dy);
          raw[i] = Math.max(0, h / 25);
        }
        line[i] = Math.max(width - 14, line[i]);
        // Wet sand: follows the water up instantly, dries back slowly.
        wet[i] = wet[i] == null ? line[i] : Math.min(line[i], wet[i] + (BASE - wet[i]) * 0.0025);
      }
      if (water) for (let i = 0; i < n; i++) {
        const avg = ((raw[i - 2] ?? raw[i]) + (raw[i - 1] ?? raw[i]) + raw[i] + (raw[i + 1] ?? raw[i]) + (raw[i + 2] ?? raw[i])) / 5;
        push[i] = (push[i] ?? 0) * 0.95 + Math.min(18, avg * 1.4) * 0.05;
        line[i] = Math.max(width - 14, line[i] - push[i]);
        wet[i] = Math.min(wet[i], line[i]);
      }
      const L = pathOf(line), Lr = line.map((x, i) => 'L' + x.toFixed(1) + ' ' + (i * STEP - STEP)).reverse().join('');
      r.sand.current.setAttribute('d', 'M0 ' + -STEP + L.replace(/^M/, 'L') + 'L0 ' + (n * STEP) + 'Z');
      r.wet.current.setAttribute('d', pathOf(wet.slice(0, n)) + Lr + 'Z');
      r.glow.current.setAttribute('d', L); r.glow.current.setAttribute('stroke-width', (6 + 16 * energy).toFixed(1)); r.glow.current.setAttribute('opacity', (0.35 + 0.45 * energy).toFixed(2));
      r.foam.current.setAttribute('d', L); r.foam.current.setAttribute('stroke-width', (1.6 + 2.4 * energy).toFixed(1));
      r.film.current.setAttribute('d', pathOf(line.map((x) => x + 10 + 26 * film))); r.film.current.setAttribute('opacity', (0.5 * film).toFixed(2));
      if (bOp > 0.02) { r.breaker.current.setAttribute('d', pathOf(brk)); r.breaker.current.setAttribute('opacity', bOp.toFixed(2)); } else r.breaker.current.setAttribute('opacity', '0');
      [r.lace0, r.lace1].forEach((ref, s) => { if (lace[s] && laceOp[s] > 0.01) { ref.current.setAttribute('d', pathOf(lace[s].map((x, i) => Math.max(width - 14, x)))); ref.current.setAttribute('opacity', laceOp[s].toFixed(2)); } else ref.current.setAttribute('opacity', '0'); });
      if (!still) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    // While animating, the next frame picks up the new size; a second loop would double the work.
    const redraw = () => still && requestAnimationFrame(frame);
    addEventListener('resize', redraw);
    return () => { cancelAnimationFrame(raf); removeEventListener('resize', redraw); };
  }, [width]);
  const W = width + 220;
  return (
    <svg aria-hidden="true" className="pointer-events-none fixed inset-y-0 left-0 z-0 hidden h-screen md:block" style={{ width: W }}>
      <defs>
        <linearGradient id="sand" x1="0" y1="0" x2={width + 80} y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#F4E7CB" />
          <stop offset={(width - 40) / (width + 80)} stopColor="#EBD9B3" />
          <stop offset="1" stopColor="#E6D2A8" />
        </linearGradient>
        <filter id="soft" x="-20%" y="-5%" width="140%" height="110%"><feGaussianBlur stdDeviation="2.4" /></filter>
        <filter id="softer" x="-30%" y="-5%" width="160%" height="110%"><feGaussianBlur stdDeviation="5" /></filter>
      </defs>
      <path ref={r.breaker} fill="none" stroke="#FFFFFF" strokeWidth="10" filter="url(#softer)" opacity="0" />
      <path ref={r.sand} fill="url(#sand)" />
      <path ref={r.wet} fill="#A88A5C" opacity="0.22" />
      <path ref={r.lace0} fill="none" stroke="#FFFFFF" strokeWidth="1.8" strokeDasharray="1.5 4 3 6" strokeLinecap="round" opacity="0" />
      <path ref={r.lace1} fill="none" stroke="#FFFFFF" strokeWidth="1.8" strokeDasharray="3 5 1.5 3" strokeLinecap="round" opacity="0" />
      <path ref={r.film} fill="none" stroke="#FFFFFF" strokeWidth="14" filter="url(#softer)" opacity="0" />
      <path ref={r.glow} fill="none" stroke="#FFFFFF" filter="url(#soft)" />
      <path ref={r.foam} fill="none" stroke="#FFFFFF" strokeLinecap="round" />
    </svg>
  );
}
