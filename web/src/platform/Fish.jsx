import { fishPath } from '../lib/motion.js';

export default function Fish({ size = 56, color = '#0B2A40', tail = 0, opacity = 1, flip = false }) {
  return (
    <svg width={size} height={size * 0.5} viewBox="-0.55 -0.25 1.1 0.5" style={{ opacity, transform: flip ? 'scaleX(-1)' : undefined, overflow: 'visible' }} aria-hidden="true">
      <path d={fishPath(tail)} fill={color} />
      <circle cx="0.36" cy="-0.025" r="0.018" fill="#F2F8FC" />
    </svg>
  );
}
