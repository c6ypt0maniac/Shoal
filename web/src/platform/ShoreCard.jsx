import { useEffect, useRef } from 'react';
import { prefersReducedMotion } from '../lib/motion.js';

// A panel made of beach, like the sidebar (Shore.jsx): the `sand` surface, with
// water along its bottom edge. Small, smooth waves run up the sand every few
// seconds and slide back, leaving wet sand that dries slowly and a lace line
// of foam at their highest reach. They stay in the bottom band, below the
// content. Still water for people who prefer reduced motion.
const rand = (a, b) => a + Math.random() * (b - a);
// Gentle in and out, so a wave never starts or stops with a jolt.
const easeSine = (p) => -(Math.cos(Math.PI * p) - 1) / 2;

const WATER = 30; // resting water depth at the bottom, px
const STEP = 14; // spacing of points along the shore; curves are drawn between them
const MAX_REACH = 30; // the wet line never climbs higher than this above the water

// A smooth curve through [x, y] points (each point is a control point, the
// curve passes through the midpoints between them).
function smooth(pts, move = true) {
  let d = (move ? 'M' : 'L') + pts[0][0] + ' ' + pts[0][1].toFixed(1);
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i], [nx, ny] = pts[i + 1];
    d += `Q${x} ${y.toFixed(1)} ${((x + nx) / 2).toFixed(1)} ${((y + ny) / 2).toFixed(1)}`;
  }
  const [lx, ly] = pts[pts.length - 1];
  return d + `L${lx} ${ly.toFixed(1)}`;
}
// Points spaced STEP apart along the shore, starting at x = -STEP.
const along = (ys) => ys.map((y, i) => [i * STEP - STEP, y]);
const curve = (ys) => smooth(along(ys));

export default function ShoreCard({ className = '', children }) {
  const box = useRef(null);
  const r = { water: useRef(null), wet: useRef(null), glow: useRef(null), foam: useRef(null), lace: [useRef(null), useRef(null), useRef(null), useRef(null)], film: useRef(null) };

  useEffect(() => {
    const el = box.current;
    const still = prefersReducedMotion();
    // Each wave leaves its own lace line (slot), so lines cross-fade instead of
    // one line jumping between waves' shapes. At most 4 waves are ever alive.
    let raf, waves = [], next = 0.6, wet = [], lastBase = null, lastT = null, foam = 0, slots = 0;

    const spawn = (t) => {
      // Small swash with broad, gentle lobes along the shore.
      waves.push({ t0: t, A: rand(7, 14), up: rand(3.2, 4), down: rand(4.6, 5.6), l: [[rand(0.18, 0.3), rand(0.006, 0.01), rand(0, 6.3)], [rand(0.08, 0.14), rand(0.014, 0.022), rand(0, 6.3)]], peak: null, slot: slots++ % 4, laceOp: 0 });
      // A new wave arrives while the last is still sliding back, so the water never stops.
      next = t + rand(4, 5.5);
    };
    const lobes = (w, x) => w.l.reduce((s, [a, f, p]) => s + a * Math.sin(x * f + p), 0);

    const frame = (now) => {
      const t = now / 1000, dt = lastT == null ? 0 : Math.min(0.1, t - lastT);
      lastT = t;
      const W = el.clientWidth, H = el.clientHeight;
      const n = Math.ceil(W / STEP) + 3, base = H - WATER;
      // The panel changed height (content loaded): start the wet line over.
      if (base !== lastBase) { wet = []; lastBase = base; }
      if (!still && t >= next) spawn(t);

      // The water between waves keeps moving: a slow swell travelling along the shore.
      const rest = Array.from({ length: n }, (_, i) => base + 2.4 * Math.sin(i * STEP * 0.012 + t * 0.32) + 1 * Math.sin(i * STEP * 0.028 - t * 0.45));
      // How far up the sand each point is pushed, by all waves together.
      const push = new Array(n).fill(0);
      let energy = 0, film = 0;
      waves = waves.filter((w) => t - w.t0 < w.up + w.down + 3);
      for (const w of waves) {
        const k = t - w.t0;
        let reach;
        if (k < w.up) {
          const p = k / w.up;
          reach = easeSine(p);
          energy = Math.max(energy, Math.sin(Math.PI * p) * 0.8);
        } else if (k < w.up + w.down) {
          const p = (k - w.up) / w.down;
          reach = 1 - easeSine(p);
          film = Math.max(film, Math.sin(Math.PI * Math.min(1, p * 1.4)) * (1 - p));
          if (!w.peak) w.peak = rest.map((y, i) => y - w.A * (1 + lobes(w, i * STEP)));
          w.laceOp = 0.65 * easeSine(Math.min(1, p * 3)) * (1 - 0.3 * p);
        } else {
          if (w.peak) w.laceOp = 0.455 * (1 - easeSine(Math.min(1, (k - w.up - w.down) / 3)));
          continue;
        }
        // Measured from the moving water, so a wave starts and ends exactly
        // where the water is (no jump), and overlapping waves blend (a soft maximum).
        for (let i = 0; i < n; i++) push[i] += (w.A * reach * (1 + lobes(w, i * STEP))) ** 4;
      }
      const shore = rest.map((y, i) => y - push[i] ** 0.25);
      // Wet sand follows the water up at once and dries back slowly (same speed at any frame rate).
      const dry = 1 - Math.exp(-dt * 0.25);
      for (let i = 0; i < n; i++) {
        const prev = wet[i] ?? shore[i];
        wet[i] = Math.max(base - MAX_REACH, Math.min(shore[i], prev + (base - prev) * dry));
      }

      const L = curve(shore);
      // The wet band: along the wet line, then back along the water's edge.
      const backPath = smooth(along(shore).reverse(), false);
      r.water.current.setAttribute('d', L + `L${n * STEP} ${H + 2}L${-STEP} ${H + 2}Z`);
      r.wet.current.setAttribute('d', curve(wet.slice(0, n)) + backPath + 'Z');
      r.glow.current.setAttribute('d', L);
      foam += (energy - foam) * (1 - Math.exp(-dt * 1.5));
      r.glow.current.setAttribute('opacity', (0.35 + 0.35 * foam).toFixed(3));
      r.foam.current.setAttribute('d', L);
      r.foam.current.setAttribute('stroke-width', (1.4 + 1.2 * foam).toFixed(2));
      r.film.current.setAttribute('d', curve(shore.map((y) => y + 5 + 8 * film)));
      r.film.current.setAttribute('opacity', (0.4 * film).toFixed(3));
      r.lace.forEach((ref, slot) => {
        const w = waves.find((x) => x.slot === slot && x.peak);
        if (w && w.laceOp > 0.005) {
          ref.current.setAttribute('d', curve(w.peak.map((y) => Math.max(y, base - MAX_REACH))));
          ref.current.setAttribute('opacity', w.laceOp.toFixed(3));
        } else ref.current.setAttribute('opacity', '0');
      });
      if (!still) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    // While animating, the next frame picks up the new size; a second loop would double the work.
    const ro = new ResizeObserver(() => still && requestAnimationFrame(frame));
    ro.observe(el);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  return (
    <div ref={box} className={'sand relative overflow-hidden ' + className}>
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full">
        <defs>
          <linearGradient id="shore-card-water" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#A9E4D8" stopOpacity="0.9" />
            <stop offset="1" stopColor="#5FC2B2" stopOpacity="0.95" />
          </linearGradient>
          <filter id="shore-card-soft" x="-5%" y="-50%" width="110%" height="200%"><feGaussianBlur stdDeviation="2" /></filter>
          <filter id="shore-card-softer" x="-5%" y="-50%" width="110%" height="200%"><feGaussianBlur stdDeviation="4" /></filter>
        </defs>
        <path ref={r.wet} fill="#A88A5C" opacity="0.2" />
        {r.lace.map((ref, i) => <path key={i} ref={ref} fill="none" stroke="#FFFFFF" strokeWidth="1.6" strokeDasharray={['1.5 4 3 6', '3 5 1.5 3', '2 6 4 4', '1 5 3 4'][i]} strokeLinecap="round" opacity="0" />)}
        <path ref={r.water} fill="url(#shore-card-water)" />
        <path ref={r.film} fill="none" stroke="#FFFFFF" strokeWidth="9" filter="url(#shore-card-softer)" opacity="0" />
        <path ref={r.glow} fill="none" stroke="#FFFFFF" strokeWidth="7" filter="url(#shore-card-soft)" />
        <path ref={r.foam} fill="none" stroke="#FFFFFF" strokeLinecap="round" />
      </svg>
      <div className="relative" style={{ paddingBottom: WATER + 26 }}>{children}</div>
    </div>
  );
}
