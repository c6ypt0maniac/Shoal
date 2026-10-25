import { useLayoutEffect, useRef, useState } from 'react';

// The floating Shoal mark: a plank of wood floating in the water, slightly
// translucent. Beige wood
// with grain, rough-cut ends, its thickness showing along the lower
// edge, darker where it's wet, water lapping over that edge with a foam line,
// and ripples spreading around it. The whole plank is the way into the
// platform, like Get started.

const PAD = 56; // room around the link for the plank's ends and the ripples
const END = 40; // how far the plank reaches past the name on each side
const THICK = 5; // the plank's visible side

// A plank around a w x h box: long and straight, with uneven, worn ends.
function plank(w, h, dy = 0) {
  const x0 = -END, x1 = w + END, t = 2 + dy, b = h - 2 + dy;
  return [
    `M${x0 + 3} ${t + 1}`,
    `L${w * 0.35} ${t}`, `L${w * 0.7} ${t + 0.8}`, `L${x1 - 4} ${t}`,
    // Right end: a rough break.
    `L${x1 - 1} ${t + h * 0.18}`, `L${x1 + 2} ${t + h * 0.38}`, `L${x1 - 2} ${t + h * 0.55}`, `L${x1 + 1} ${t + h * 0.78}`, `L${x1 - 3} ${b}`,
    `L${w * 0.6} ${b + 0.8}`, `L${w * 0.2} ${b}`, `L${x0 + 2} ${b - 0.5}`,
    // Left end: cut, but worn at the corners.
    `L${x0} ${b - h * 0.2}`, `L${x0 - 1} ${t + h * 0.45}`, `L${x0 + 1} ${t + h * 0.2}`,
    'Z',
  ].join('');
}

// A ripple ring around the plank, `out` px from it.
const ripple = (w, h, out) => {
  const cx = w / 2, cy = h / 2 + 3, rx = w / 2 + END + out, ry = h / 2 + out * 0.55;
  return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
};

export default function Nav() {
  const link = useRef(null);
  const [size, setSize] = useState(null);
  useLayoutEffect(() => {
    const el = link.current;
    const measure = () => setSize({ w: el.offsetWidth, h: el.offsetHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const clickable = { pointerEvents: 'auto', cursor: 'pointer' };

  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-40 flex justify-center px-4 [@media(max-height:560px)]:absolute">
      <a
        ref={link}
        href="/app"
        aria-label="Open the Shoal platform"
        className="group pointer-events-auto relative flex -rotate-[1.5deg] items-center gap-2.5 whitespace-nowrap rounded-full px-3 py-[9px] text-[19px] font-semibold tracking-[-0.03em] text-ink outline-offset-8 transition-transform duration-700 hover:-translate-y-px hover:-rotate-[0.5deg] focus-visible:outline-2 focus-visible:outline-accent"
      >
        {size && (
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute overflow-visible"
            style={{ left: -PAD, top: -PAD, width: size.w + PAD * 2, height: size.h + PAD * 2 }}
          >
            <defs>
              <linearGradient id="plank-top" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#F5D29A" />
                <stop offset="0.6" stopColor="#E9B676" />
                <stop offset="1" stopColor="#D29358" />
              </linearGradient>
              {/* Wood grain: noise stretched along the plank, in brown. */}
              <filter id="plank-grain" x="0" y="0" width="100%" height="100%">
                <feTurbulence type="fractalNoise" baseFrequency="0.01 0.25" numOctaves="3" seed="11" />
                <feColorMatrix values="0 0 0 0 0.52  0 0 0 0 0.3  0 0 0 0 0.1  0 0 0 0.8 -0.22" />
                <feComposite in2="SourceGraphic" operator="in" />
              </filter>
              <clipPath id="plank-clip"><path d={plank(size.w, size.h)} /></clipPath>
              {/* The whole plank, top and side: the water only laps over the wood. */}
              <clipPath id="plank-body"><path d={plank(size.w, size.h)} /><path d={plank(size.w, size.h, THICK)} /></clipPath>
              <filter id="plank-blur" x="-20%" y="-80%" width="140%" height="260%"><feGaussianBlur stdDeviation="4" /></filter>
              <filter id="plank-soft" x="-10%" y="-80%" width="120%" height="260%"><feGaussianBlur stdDeviation="1.1" /></filter>
            </defs>
            <g transform={`translate(${PAD} ${PAD})`}>
              {/* Ripples spreading on the water around it. */}
              <g fill="none" stroke="#FFFFFF" strokeLinecap="round">
                <path d={ripple(size.w, size.h, 10)} strokeWidth="1.6" strokeDasharray="14 8 5 10" opacity="0.5" className="transition-opacity duration-700 group-hover:opacity-80" />
                <path d={ripple(size.w, size.h, 22)} strokeWidth="1.2" strokeDasharray="6 12 18 9" opacity="0.28" className="transition-opacity duration-700 group-hover:opacity-50" />
              </g>
              {/* Its shadow in the water. */}
              <path d={plank(size.w, size.h, 6)} fill="#0B4A55" opacity="0.2" filter="url(#plank-blur)" />
              {/* The plank, slightly translucent so the water shows through.
                  The name on it stays solid. */}
              <g opacity="0.68">
              {/* The plank's side, visible along the lower edge. */}
              <path d={plank(size.w, size.h, THICK)} fill="#A06A34" style={clickable} />
              {/* The top face, its grain, and the wood details. */}
              <path d={plank(size.w, size.h)} fill="url(#plank-top)" style={clickable} />
              <path d={plank(size.w, size.h)} fill="#000" filter="url(#plank-grain)" />
              <g clipPath="url(#plank-clip)">
                <g fill="none" stroke="#965F2C" strokeLinecap="round" opacity="0.32">
                  <path d={`M${-END} ${size.h * 0.24} C${size.w * 0.25} ${size.h * 0.18} ${size.w * 0.55} ${size.h * 0.3} ${size.w + END} ${size.h * 0.22}`} strokeWidth="0.9" />
                  <path d={`M${-END} ${size.h * 0.58} C${size.w * 0.2} ${size.h * 0.52} ${size.w * 0.6} ${size.h * 0.64} ${size.w + END} ${size.h * 0.57}`} strokeWidth="0.9" />
                  <path d={`M${-END} ${size.h * 0.8} C${size.w * 0.3} ${size.h * 0.86} ${size.w * 0.7} ${size.h * 0.76} ${size.w + END} ${size.h * 0.82}`} strokeWidth="0.7" />
                </g>
                {/* Wet wood near the waterline. */}
                <rect x={-END - 4} y={size.h * 0.74} width={size.w + END * 2 + 8} height={size.h * 0.3} fill="#7E4F22" opacity="0.18" />
                {/* Sun on the dry top edge. */}
                <path d={`M${-END + 6} ${4} L${size.w + END - 8} ${3.5}`} stroke="#FFFFFF" strokeWidth="1.4" opacity="0.45" strokeLinecap="round" />
              </g>
              </g>
              {/* Water lapping over the lower edge, and the foam where it meets the wood. */}
              <path
                d={`M${-END - 6} ${size.h - 1} C${size.w * 0.15} ${size.h - 4} ${size.w * 0.35} ${size.h + 1} ${size.w * 0.55} ${size.h - 3} S${size.w + END * 0.6} ${size.h} ${size.w + END + 6} ${size.h - 2} L${size.w + END + 6} ${size.h + THICK + 6} L${-END - 6} ${size.h + THICK + 6}Z`}
                fill="#9FDCCF"
                opacity="0.55"
                clipPath="url(#plank-body)"
              />
              <path
                d={`M${-END - 3} ${size.h - 1} C${size.w * 0.15} ${size.h - 4} ${size.w * 0.35} ${size.h + 1} ${size.w * 0.55} ${size.h - 3} S${size.w + END * 0.6} ${size.h} ${size.w + END + 3} ${size.h - 2}`}
                fill="none"
                stroke="#FFFFFF"
                strokeWidth="1.8"
                strokeLinecap="round"
                opacity="0.85"
                filter="url(#plank-soft)"
              />
            </g>
          </svg>
        )}
        <img src="/logo-mark.png" alt="" aria-hidden="true" className="relative block h-[1.2em] w-auto" />
        <span className="relative">Shoal</span>
      </a>
    </div>
  );
}
