// Connecting a repo (GitHub or the bundled demo), choosing what agents can see,
// and keeping the connection in sync (server/src/index.js, scope.js, sync.js).
import { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { Tag, Toggle, card, field, ghost, primary } from './ui.jsx';

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.');
const label = (d) => (d === '.' ? 'Files in the repo root' : d + '/');
const ago = (iso) => { if (!iso) return 'never'; const m = Math.round((Date.now() - Date.parse(iso)) / 60_000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; };

// Folders agents may see. Each folder counts on its own on the server, so
// ticking a folder ticks its subfolders too and every ticked folder is sent.
// All ticked = the whole repo ([]).
function FolderPicker({ files, hidden, setHidden }) {
  const dirs = useMemo(() => {
    const m = new Map();
    for (const f of files) {
      if (f.secret) continue;
      const d = dirOf(f.path), row = m.get(d) ?? { files: 0, tests: 0 };
      row.files += 1; if (f.test) row.tests += 1; m.set(d, row);
    }
    return [...m.entries()].sort(([a], [b]) => (a === '.' ? -1 : b === '.' ? 1 : a.localeCompare(b)));
  }, [files]);
  const secrets = files.filter((f) => f.secret).length;
  const under = (d, x) => x === d || (d !== '.' && x.startsWith(d + '/'));
  const toggle = (d) => setHidden((h) => { const n = new Set(h), on = n.has(d); for (const [x] of dirs) if (under(d, x)) on ? n.delete(x) : n.add(x); return n; });
  const shown = dirs.filter(([d]) => !hidden.has(d)).reduce((n, [, r]) => n + r.files, 0);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
        <span>Agents can see {shown} of {files.length - secrets} files{secrets ? ' · ' + secrets + ' secret file' + (secrets === 1 ? '' : 's') + ' never shared' : ''}</span>
        <span className="flex gap-3"><button className="cursor-pointer text-accent" onClick={() => setHidden(new Set())}>All</button><button className="cursor-pointer text-accent" onClick={() => setHidden(new Set(dirs.map(([d]) => d)))}>None</button></span>
      </div>
      <div className="flex max-h-[280px] flex-col overflow-y-auto rounded-xl border border-ink/15 bg-white/50">
        {dirs.map(([d, r]) => (
          <label key={d} className="flex cursor-pointer items-center gap-3 border-t border-ink/10 px-3 py-2 text-[15px] first:border-t-0" style={{ paddingLeft: 12 + (d === '.' ? 0 : d.split('/').length - 1) * 18 }}>
            <input type="checkbox" className="size-4 accent-[#0A7470]" checked={!hidden.has(d)} onChange={() => toggle(d)} />
            <span className="min-w-0 flex-1 truncate font-mono text-sm">{label(d)}</span>
            <span className="shrink-0 text-sm tabular-nums text-muted">{r.files} file{r.files === 1 ? '' : 's'}{r.tests ? ' · ' + r.tests + ' test' + (r.tests === 1 ? '' : 's') : ''}</span>
          </label>
        ))}
      </div>
      <span className="text-sm text-muted">.env files, keys, certificates and secrets/ folders are never shared, even inside a ticked folder.</span>
    </div>
  );
}

function ConnectForm({ s, act }) {
  const [problems, setProblems] = useState(null), [picked, setPicked] = useState(['flaky-tests']);
  const [repos, setRepos] = useState(null), [repo, setRepo] = useState(''), [typed, setTyped] = useState('');
  const [files, setFiles] = useState(null), [filesErr, setFilesErr] = useState(''), [hidden, setHidden] = useState(new Set());
  const signedIn = Boolean(s.me?.viewer), source = typed.trim() || repo;
  const last = [...s.events].reverse().find((e) => /^connect\./.test(e.type));
  const connecting = last?.type === 'connect.step' ? last.message : '';
  useEffect(() => { api.problems().then(setProblems).catch(() => setProblems([])); }, []);
  useEffect(() => { if (signedIn && !repos) api.repos().then(setRepos).catch(() => setRepos([])); }, [signedIn, repos]);
  // Load the file list for the folder picker once a repo is chosen.
  useEffect(() => {
    if (!source) { setFiles(null); return; }
    let live = true;
    setFiles(null); setFilesErr(''); setHidden(new Set());
    const t = setTimeout(() => api.repoFiles(source === 'demo' ? 'demo' : source).then((r) => live && setFiles(r.files)).catch((e) => live && setFilesErr(e.message)), typed ? 600 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [source]);
  const sharedPaths = () => {
    if (!files || !hidden.size) return [];
    return [...new Set(files.filter((f) => !f.secret).map((f) => dirOf(f.path)))].filter((d) => !hidden.has(d));
  };
  const opts = () => ({ problems: picked.map((id) => ({ id })), sharedPaths: sharedPaths() });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5 text-sm text-muted">What is slowing your team down?
        <div className="flex flex-wrap gap-2">{(problems || []).map((p) => (
          <button key={p.id} onClick={() => setPicked((x) => (x.includes(p.id) ? x.filter((y) => y !== p.id) : [...x, p.id]))} className={'cursor-pointer rounded-full border px-3 py-1.5 text-[15px] ' + (picked.includes(p.id) ? 'border-ink bg-ink text-paper' : 'border-ink/15 bg-white/60 text-ink')}>
            {p.label}{!p.supported && <span className="opacity-60"> · soon</span>}
          </button>
        ))}</div>
      </div>
      <div className="flex flex-col gap-2">
        {signedIn
          ? <select className={field} value={repo} onChange={(e) => { setRepo(e.target.value); setTyped(''); }}><option value="">{repos ? 'Choose one of your repositories' : 'Loading repositories…'}</option>{(repos || []).map((r) => <option key={r.fullName} value={r.fullName}>{r.fullName}{r.private ? ' (private)' : ''}</option>)}</select>
          : s.me?.oauth !== false && <a href="/api/auth/github?return=/app%23setup" className={primary + ' self-start text-paper hover:text-paper'}>Sign in with GitHub for private repos</a>}
        <input className={field} value={typed} onChange={(e) => { setTyped(e.target.value); setRepo(''); }} placeholder={signedIn ? 'Or paste any owner/name or GitHub URL' : 'Public repo: owner/name or GitHub URL'} />
        <button className={ghost + ' self-start'} onClick={() => { setRepo('demo'); setTyped(''); }}>Use the bundled demo repo instead</button>
      </div>
      {source && <div className="flex flex-col gap-2"><span className="text-sm font-medium text-muted">What agents can see in {source === 'demo' ? 'the demo repo' : source}</span>
        {filesErr ? <span className="text-sm text-bad">Couldn't list files: {filesErr}</span> : files ? <FolderPicker files={files} hidden={hidden} setHidden={setHidden} /> : <span className="text-sm text-muted">Loading files…</span>}
      </div>}
      <button className={primary + ' self-start'} disabled={!source || !!connecting || (files && hidden.size && !sharedPaths().length)}
        onClick={act(() => (source === 'demo' ? api.connectDemo(opts()) : api.connect(source, opts())))}>{connecting ? 'Connecting…' : 'Connect'}</button>
      {connecting && <span className="text-sm text-muted">{connecting}</span>}
      {last?.type === 'connect.failed' && <span className="text-sm text-bad">{last.message}</span>}
    </div>
  );
}

export function Setup({ s, act, steps, onPost, go }) {
  const last = (re) => [...s.events].reverse().find((e) => re.test(e.type));
  const scanning = ['scan.started', 'scan.file'].includes(last(/^scan\./)?.type);
  // Connecting again (to another repo) reopens the first step until a newer connect.done arrives.
  const [changing, setChanging] = useState(null);
  const done = last(/^connect\.done$/)?.id ?? 0;
  useEffect(() => { if (changing !== null && done > changing) setChanging(null); }, [done, changing]);
  steps = changing !== null ? [false, false, false] : steps;
  const cur = steps.findIndex((x) => !x);
  const rows = [
    ['Connect your code', 'Pick a GitHub repo, or try the bundled demo, and choose which folders agents can see.', <ConnectForm s={s} act={act} />],
    ['Find flaky tests', 'Shoal runs every test file 10 times and prices each flaky one by the dev-hours it costs.', <button className={primary} disabled={!steps[0] || scanning} onClick={act(api.scan)}>{scanning ? 'Scanning…' : 'Scan my tests'}</button>],
    ['Post your first bounty', "Set a reward and pick who competes. It's held, not charged, until a fix passes 10 runs in a row and survives.", <div className="flex flex-wrap gap-2"><button className={primary} disabled={!steps[1]} onClick={onPost}>Post a bounty</button><button className={ghost} disabled={!steps[1]} onClick={() => go('agents')}>Browse agents first</button><button className={ghost} disabled={!steps[1]} onClick={() => go('trials')}>Try models for free</button></div>],
  ];
  return (
    <section className="flex flex-col gap-5">
      <h2 className="m-0 border-b border-ink/12 pb-3 text-[24px] font-semibold tracking-[-0.025em]">Setup</h2>
      <div className="flex gap-1">{steps.map((ok, i) => <span key={i} className={'h-1.5 flex-1 rounded-full ' + (ok ? 'bg-accent' : 'bg-ink/15')} />)}</div>
      {rows.map(([t, b, action], i) => (
        <div key={t} className={card + (i === 0 && !steps[0] ? '' : ' xl:flex-row xl:items-center') + ' xl:gap-6 ' + (cur === i ? 'ring-2 ring-accent/50' : steps[i] ? '' : 'opacity-55')}>
          <span className={'flex size-12 shrink-0 items-center justify-center rounded-2xl text-lg font-semibold ' + (steps[i] ? 'bg-accent text-paper' : 'bg-white/70')}>{steps[i] ? '✓' : i + 1}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-1"><div className="text-[20px] font-semibold tracking-[-0.02em]">{t}</div><div className="text-[15px] text-muted">{b}</div></div>
          <div className={'min-w-0 ' + (i === 0 && !steps[0] ? '' : 'xl:max-w-[520px]')}>{steps[i] ? <span className="flex flex-wrap items-center gap-3 text-[15px] text-accent">Done{i === 0 && s.connection?.fullName ? ' · ' + s.connection.fullName : ''}{i === 0 && <button className="cursor-pointer text-muted underline" onClick={() => setChanging(done)}>Connect a different repo</button>}</span> : action}</div>
        </div>
      ))}
      {changing !== null && <button className={ghost + ' self-start'} onClick={() => setChanging(null)}>Keep {s.connection?.fullName}</button>}
      {steps.every(Boolean) && <div className="glass rounded-2xl px-5 py-4">You're set up. <button className="cursor-pointer text-accent underline" onClick={() => go('bounties')}>Go to your bounties</button>.</div>}
    </section>
  );
}

export function Repo({ s, act, go }) {
  const c = s.connection || {}, sync = c.sync || {}, gh = c.type === 'github';
  const [ci, setCi] = useState(null);
  useEffect(() => { api.ci().then(setCi).catch(() => setCi([])); }, [c.fullName]);
  const hiddenSources = [...new Set(s.pains.flatMap((p) => p.hiddenSources || []))];
  const shared = c.sharedPaths || [];
  const H = ({ children }) => <h2 className="m-0 border-b border-ink/12 pb-3 text-[24px] font-semibold tracking-[-0.025em]">{children}</h2>;
  return (
    <section className="flex flex-col gap-5">
      <H>Connected</H>
      <div className={card}>
        <div className="flex items-start justify-between gap-4"><div className="flex min-w-0 flex-col"><span className="truncate text-[21px] font-semibold">{c.fullName || 'Nothing connected'}</span><span className="text-[15px] text-muted">{gh ? 'GitHub' + (c.defaultBranch ? ' · ' + c.defaultBranch : '') + (c.private ? ' · private' : '') : 'Bundled demo repo'}{c.head ? ' · ' + c.head.sha.slice(0, 7) + ' ' + c.head.message : ''}</span></div>
          <button className={ghost} onClick={() => go('setup')}>Change</button></div>
        <div className="flex flex-wrap gap-2">
          <Tag>{s.pains.length} test files scanned</Tag><Tag>{s.pains.filter((p) => !p.healthy).length} flaky</Tag>
          {gh && <Tag tone={c.canWrite ? 'ok' : undefined}>{c.canWrite ? 'Can open PRs' : 'Read-only, no PRs'}</Tag>}
          {(c.problems || []).map((p) => <Tag key={p.id}>{p.label}</Tag>)}
        </div>
        {c.tests?.length > 0 && <div className="flex flex-col gap-1 border-t border-ink/10 pt-3 text-[15px]">{c.tests.map((t) => <span key={t.id + t.root}>{t.language} · {t.framework}{t.root !== '.' ? ' in ' + t.root + '/' : ''} {t.toolOk ? <span className="text-muted">· <code className="text-sm">{t.example}</code></span> : <span className="text-bad">· {t.toolMessage || 'toolchain missing'}</span>}</span>)}</div>}
      </div>

      <H>What agents can see</H>
      <div className={card}>
        <span className="text-[15px]">{shared.length ? shared.map(label).join(', ') : 'The whole repo, except secrets.'}</span>
        {hiddenSources.length > 0 && <div className="flex flex-col gap-2 rounded-xl border border-bad/30 bg-bad/5 p-3 text-[15px]">
          <span>Your flaky tests import code agents can't see: <span className="font-mono text-sm">{hiddenSources.join(', ')}</span></span>
          <button className={ghost + ' self-start'} onClick={act(() => api.share(hiddenSources))}>Share these files with agents</button>
        </div>}
        {sync.newPaths?.length > 0 && <div className="flex flex-col gap-2 rounded-xl border border-ink/15 bg-white/50 p-3 text-[15px]">
          <span>New folders since you connected: <span className="font-mono text-sm">{sync.newPaths.map(label).join(', ')}</span></span>
          <button className={ghost + ' self-start'} onClick={act(() => api.share(sync.newPaths))}>Share them too</button>
        </div>}
      </div>

      {gh && <>
        <H>Sync with GitHub</H>
        <div className={card + ' md:flex-row md:items-center'}>
          <div className="flex flex-1 flex-col gap-1 text-[15px]">
            <span>Last checked {ago(sync.checkedAt)} · last pulled {ago(sync.syncedAt)}</span>
            {sync.waiting && <span className="text-muted">Waiting for {sync.waiting} to finish</span>}
            {sync.error && <span className="text-bad">{sync.error}</span>}
          </div>
          <label className="flex items-center gap-3 text-[15px]">Auto-sync every minute<Toggle on={Boolean(sync.auto)} label="Auto-sync" onChange={act((on) => api.autoSync(on))} /></label>
          <button className={ghost} disabled={sync.syncing} onClick={act(api.sync)}>{sync.syncing ? 'Syncing…' : 'Sync now'}</button>
        </div>
        <H>GitHub Actions</H>
        <div className="glass rounded-[20px] px-6 py-2">
          {ci === null && <div className="py-4 text-muted">Loading…</div>}
          {ci?.length === 0 && <div className="py-4 text-muted">No completed workflow runs found.</div>}
          {ci?.map((w) => <div key={w.workflow} className="grid grid-cols-[minmax(0,1fr)_repeat(3,90px)] gap-4 border-t border-ink/10 py-3 tabular-nums first:border-t-0"><span className="truncate">{w.workflow}</span><span className={w.failureRate > 0.1 ? 'text-bad' : ''}>{Math.round(w.failureRate * 100)}% fail</span><span>{Math.round(w.rerunRate * 100)}% rerun</span><span className="text-right text-muted">{w.avgMinutes != null ? w.avgMinutes + ' min' : '–'}</span></div>)}
        </div>
      </>}
      <div className="flex flex-wrap gap-3"><button className={ghost} onClick={act(api.scan)}>Rescan</button><button className={ghost} onClick={act(api.reset)}>Reset workspace</button></div>
    </section>
  );
}
