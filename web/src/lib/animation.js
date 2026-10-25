// Decorative animation yields to scrolling, hidden tabs and reduced motion.
export function animate(frame, { paused = false, element, fps = 30 } = {}) {
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let raf = 0, timer = 0, last = -Infinity, visible = true, scrolling = false, disposed = false;
  const active = () => !disposed && !paused && !motion.matches && !document.hidden && visible && !scrolling;
  const tick = time => {
    raf = 0;
    if (!active()) return;
    if (time - last >= 1000 / fps) { last = time; frame(time); }
    raf = requestAnimationFrame(tick);
  };
  const update = () => { cancelAnimationFrame(raf); raf = 0; if (active()) raf = requestAnimationFrame(tick); };
  const scroll = () => { scrolling = true; update(); clearTimeout(timer); timer = setTimeout(() => { scrolling = false; update(); }, 140); };
  const observer = element && new IntersectionObserver(entries => { visible = entries[0].isIntersecting; update(); });
  observer?.observe(element);
  if (!document.hidden) frame(performance.now());
  update();
  document.addEventListener('visibilitychange', update);
  document.addEventListener('scroll', scroll, { passive: true, capture: true });
  motion.addEventListener('change', update);
  return () => { disposed = true; cancelAnimationFrame(raf); clearTimeout(timer); observer?.disconnect(); document.removeEventListener('visibilitychange', update); document.removeEventListener('scroll', scroll, true); motion.removeEventListener('change', update); };
}
