import { useEffect, useRef } from 'react';
import { prefersReducedMotion } from '../lib/motion.js';

const HIDDEN = { opacity: '0', transform: 'translateY(28px)' };
const EASE = 'opacity .9s ease, transform .9s cubic-bezier(.2,.7,.2,1)';

// Fades in whenever it enters from below (scrolling down), every time.
// Scrolling up shows it instantly; it never fades out on screen.
export default function Reveal({ as: Tag = 'div', className = '', children, waitForScroll = false, ...rest }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    const set = (s, transition) => { el.style.transition = transition; Object.assign(el.style, s); };
    set(HIDDEN, 'none');
    if (waitForScroll) {
      let lastY = window.scrollY;
      const onScroll = () => {
        const currentY = window.scrollY;
        const scrollingDown = currentY > lastY;
        lastY = currentY;
        if (!scrollingDown) return;
        const { top, bottom } = el.getBoundingClientRect();
        if (top < window.innerHeight && bottom > 0) {
          void el.offsetWidth;
          set({ opacity: '1', transform: 'none' }, EASE);
          window.removeEventListener('scroll', onScroll);
        }
      };
      window.addEventListener('scroll', onScroll, { passive: true });
      return () => window.removeEventListener('scroll', onScroll);
    }
    const io = new IntersectionObserver(([en]) => {
      const top = en.boundingClientRect.top;
      if (en.isIntersecting) {
        if (top > 0) { void el.offsetWidth; set({ opacity: '1', transform: 'none' }, EASE); }
        else set({ opacity: '1', transform: 'none' }, 'none');
      } else if (top > 0) set(HIDDEN, 'none');
    }, { threshold: 0.12 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <Tag ref={ref} className={className} {...rest}>{children}</Tag>;
}
