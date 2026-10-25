// Shared building blocks for the platform pages.
import { useEffect } from 'react';

export const btn = 'inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-[15px] font-medium transition-colors disabled:cursor-default disabled:opacity-40';
export const primary = btn + ' bg-accent text-paper hover:bg-ink';
export const ghost = btn + ' border border-ink/15 bg-white/55 text-ink hover:bg-white/85';
export const field = 'w-full rounded-xl border border-ink/15 bg-white/60 px-3 py-2.5 text-base text-ink outline-none focus:border-accent';
export const card = 'glass flex flex-col gap-3 rounded-[20px] p-6';
export const money = (n) => '$' + Number(n || 0).toLocaleString();
export const LIVE = ['competing', 'verifying', 'judging'];
export const STATUS = { open: 'Open', awaiting_funding: 'Needs funding', competing: 'Racing', verifying: 'Verifying', judging: 'Judging', surviving: 'Survival window', settled: 'Fixed', clawed_back: 'Clawed back', failed: 'No fix', payment_failed: 'Payment failed' };
export const tone = (status) => (status === 'settled' ? 'ok' : ['failed', 'clawed_back', 'payment_failed'].includes(status) ? 'bad' : undefined);

// Line icons, 20px, stroke = currentColor.
export const PATHS = {
  user: 'M10 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 7c.6-3 3-4.5 6-4.5s5.4 1.5 6 4.5',
  card: 'M3 5.5h14v9H3zM3 8.5h14',
  play: 'M5 4l11 6-11 6z',
  repo: 'M5 3h9a1 1 0 0 1 1 1v12H6a1 1 0 0 1-1-1zM5 13.5h10M8 6h4',
  pulse: 'M2 10h4l2-5 4 10 2-5h4',
  bounty: 'M10 2.5v15M13.5 5.5H8.25a2.25 2.25 0 0 0 0 4.5h3.5a2.25 2.25 0 0 1 0 4.5H6',
  fish: 'M17 10c-2-3.5-6-4.5-9-2.5L4 5v10l4-2.5c3 2 7 1 9-2.5Z',
  plus: 'M10 4v12M4 10h12',
  chart: 'M4 16V9M8 16V5M12 16v-6M16 16V7',
  search: 'M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12Zm4.5-1.5L17 17',
  refresh: 'M16 7a6.5 6.5 0 0 0-11.5-1.5M4 3v3h3M4 13a6.5 6.5 0 0 0 11.5 1.5M16 17v-3h-3',
  star: 'M10 2.8l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 8.1l5-.7z',
  chip: 'M6 6h8v8H6zM8 3v3M12 3v3M8 14v3M12 14v3M3 8h3M3 12h3M14 8h3M14 12h3',
  flask: 'M8 2.5h4M8.5 2.5v5L4 16a1 1 0 0 0 .9 1.5h10.2a1 1 0 0 0 .9-1.5l-4.5-8.5v-5M6 12.5h8',
};
export const Icon = ({ n, size = 20, fill = 'none', className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill={fill} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={'shrink-0 ' + className} aria-hidden="true"><path d={PATHS[n]} /></svg>
);

export function Browse({ label = 'Browse', q, setQ, placeholder, onRefresh, chips, chip, setChip, children }) {
  return (
    <section className="flex flex-col gap-5">
      <h2 className="m-0 border-b border-ink/12 pb-3 text-[24px] font-semibold tracking-[-0.025em]">{label}</h2>
      <div className="flex gap-3">
        <label className="glass flex flex-1 items-center gap-3 rounded-xl px-4 py-3 focus-within:border-accent">
          <Icon n="search" className="text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} className="w-full bg-transparent text-base outline-none placeholder:text-faint" />
        </label>
        <button className={ghost + ' glass'} onClick={onRefresh}><Icon n="refresh" size={18} />Refresh</button>
      </div>
      {chips && (
        <div className="flex flex-wrap gap-2">
          {chips.map(([id, label, n]) => (
            <button key={id} onClick={() => setChip(id)} disabled={!n && id !== chip} className={'flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-full border px-4 py-1.5 text-[15px] disabled:cursor-default disabled:opacity-45 ' + (chip === id ? 'border-ink/40 bg-white/75 font-medium' : 'border-ink/15 bg-white/35 hover:bg-white/60')}>
              {label}<span className="tabular-nums text-muted">{n}</span>
            </button>
          ))}
        </div>
      )}
      {children}
    </section>
  );
}
export const Group = ({ title, children }) => (
  <div className="flex flex-col gap-4"><div className="text-[17px] font-semibold">{title}</div><div className="grid grid-cols-1 gap-4 md:grid-cols-2">{children}</div></div>
);
export const Tag = ({ children, tone }) => <span className={'rounded-full px-3 py-1 text-[13.5px] tabular-nums ' + (tone === 'bad' ? 'bg-bad/12 text-bad' : tone === 'ok' ? 'bg-accent/15 text-accent' : 'bg-ink/7 text-ink')}>{children}</span>;
export const Empty = ({ children }) => <div className="glass col-span-full rounded-[20px] p-8 text-center text-muted">{children}</div>;
export function Toggle({ on, onChange, label }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} onClick={(e) => { e.stopPropagation(); onChange(!on); }} className={'relative h-7 w-12 shrink-0 cursor-pointer rounded-full transition-colors ' + (on ? 'bg-accent' : 'bg-ink/20')}>
      <span className="absolute top-0.5 size-6 rounded-full bg-white shadow transition-[left]" style={{ left: on ? 22 : 2 }} />
    </button>
  );
}
export function Stars({ r, n }) {
  if (r == null) return <span className="text-sm text-muted">New, no ratings yet</span>;
  return (
    <span className="flex items-center gap-1.5 text-sm text-muted">
      <span className="flex">{[1, 2, 3, 4, 5].map((i) => <Icon key={i} n="star" size={15} fill={r >= i - 0.25 ? '#9A5B00' : 'none'} className={r >= i - 0.25 ? 'text-[#9A5B00]' : 'text-ink/25'} />)}</span>
      <span className="tabular-nums text-ink">{r.toFixed(1)}</span><span className="tabular-nums">({n})</span>
    </span>
  );
}
export function ItemCard({ icon, toggle, title, by, meta, tags, body, footL, footR, onOpen }) {
  return (
    <div onClick={onOpen} className={card + ' cursor-pointer transition-[transform,border-color] hover:-translate-y-0.5 hover:border-accent/40'}>
      <div className="flex items-start justify-between"><div className="flex size-12 items-center justify-center rounded-2xl bg-white/70 text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">{icon}</div>{toggle}</div>
      <div className="flex flex-col gap-0.5"><div className="truncate text-[21px] font-semibold tracking-[-0.02em]">{title}</div><div className="text-[15px] text-muted">{by}</div></div>
      {meta}
      {tags && <div className="flex flex-wrap gap-2">{tags}</div>}
      {body && <p className="m-0 line-clamp-3 text-[15px] text-muted">{body}</p>}
      <div className="mt-auto flex items-center justify-between gap-3 pt-2"><span className="text-[15px] text-muted">{footL}</span>{footR}</div>
    </div>
  );
}

export function Modal({ onClose, children, wide }) {
  useEffect(() => { const k = (e) => e.key === 'Escape' && onClose(); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [onClose]);
  return (
    // Sand, like the sidebar and the sign-in popup, over a light blur of the page.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/15 p-4 backdrop-blur-md" onClick={onClose}>
      <div className={'sand relative max-h-[92vh] w-full overflow-y-auto rounded-[24px] ' + (wide ? 'max-w-[1040px]' : 'max-w-[620px]')} onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} aria-label="Close" className="absolute right-4 top-4 z-10 flex size-9 cursor-pointer items-center justify-center rounded-full bg-white/60 text-lg text-ink hover:bg-white">×</button>
        {children}
      </div>
    </div>
  );
}
// "Sign in with GitHub", coming back to a platform page. In dev (Vite) the return
// is a full URL so GitHub's callback on the API server sends you back here; the
// server only allows that for origins listed in SHOAL_WEB_ORIGINS.
export const signInHref = (view) => '/api/auth/github?return=' + encodeURIComponent((import.meta.env.DEV ? location.origin : '') + '/app' + (view ? '#' + view : ''));

export const Label =({ t, children }) => <label className="flex flex-col gap-1.5 text-sm text-muted">{t}{children}</label>;
