export default function Nav() {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-40 flex justify-center px-4">
      <nav className="glass pointer-events-auto flex items-center rounded-full px-5 py-2.5">
        <a href="#top" className="flex items-center gap-2 whitespace-nowrap text-lg font-semibold tracking-[-0.03em] text-ink">
          <span className="block size-[9px] rounded-full bg-accent" />Shoal
        </a>
      </nav>
    </div>
  );
}
