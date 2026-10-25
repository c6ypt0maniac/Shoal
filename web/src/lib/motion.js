export const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Streamlined fish silhouette (nose at +x) with the tail rotated by tw radians.
export function fishPath(tw) {
  const c = Math.cos(tw), s = Math.sin(tw);
  const P = (x, y) => { const X = -0.3 + (x + 0.3) * c - y * s, Y = (x + 0.3) * s + y * c; return X.toFixed(3) + ' ' + Y.toFixed(3); };
  return 'M0.5 0C0.46 -0.08 0.28 -0.12 0.1 -0.11C-0.08 -0.1 -0.2 -0.05 ' + P(-0.3, -0.025) +
    'Q' + P(-0.4, -0.06) + ' ' + P(-0.5, -0.15) + 'Q' + P(-0.42, 0) + ' ' + P(-0.5, 0.15) +
    'Q' + P(-0.4, 0.06) + ' ' + P(-0.3, 0.025) + 'C-0.2 0.05 -0.08 0.1 0.1 0.1C0.28 0.11 0.46 0.07 0.5 0Z';
}
