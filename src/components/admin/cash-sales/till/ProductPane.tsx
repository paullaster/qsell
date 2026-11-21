'use client';

import { useEffect, useRef, useState } from 'react';
import { Package, ScanLine, Search, X } from 'lucide-react';
import { AppImage } from '@/components/ui/AppImage';
import { useDebouncedValue } from '@/components/ui/useDebouncedValue';
import { tillCodeAction, tillTilesAction, type TillStart } from '@/server/domains/selling/cash-sales/till-actions';
import type { CounterTile } from '@/server/domains/selling/cash-sales/counter-catalogue-service';
import { hueOf, initials, kes } from '@/lib/till/tile-style';

type Cursor = TillStart['next'];

/** The left side of the till: one bar that searches and takes a scanned code, the categories, what this person sells most, and the tiles. */
export function ProductPane({ start, inCart, onPick, searchRef }: { start: TillStart; inCart: ReadonlyMap<string, number>; onPick: (tile: CounterTile) => void; searchRef: React.RefObject<HTMLInputElement | null> }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [tiles, setTiles] = useState<CounterTile[]>(start.tiles);
  const [next, setNext] = useState<Cursor>(start.next);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const wanted = useDebouncedValue(query, 250);
  const first = useRef(true);

  // Tiles follow the category and the search; the first load came with the screen.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    let live = true;
    setLoading(true);
    void tillTilesAction({ categoryId: category, query: wanted, after: null }).then((r) => {
      if (!live) return;
      setLoading(false);
      if (r.ok) {
        setTiles(r.data.tiles);
        setNext(r.data.next);
        setProblem(null);
      } else setProblem(r.error);
    });
    return () => {
      live = false;
    };
  }, [category, wanted]);

  const more = async () => {
    if (next === null) return;
    setLoading(true);
    const r = await tillTilesAction({ categoryId: category, query: wanted, after: next });
    setLoading(false);
    if (r.ok) {
      setTiles((current) => [...current, ...r.data.tiles]);
      setNext(r.data.next);
    } else setProblem(r.error);
  };

  /** Enter on the bar: an exact code (a scanner types it and presses Enter) goes straight into the sale. */
  const enter = async () => {
    const code = query.trim();
    if (code === '') return;
    const r = await tillCodeAction(code);
    if (r.ok && r.data !== null) {
      onPick(r.data);
      setQuery('');
      setNote(`Added ${r.data.name}.`);
    } else if (r.ok) setNote(`No product has the code ${code}.`);
    else setProblem(r.error);
  };

  const showRecent = query.trim() === '' && category === null && start.recent.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <input
          ref={searchRef}
          type="search"
          aria-label="Search a product or scan its code"
          data-testid="till-search"
          placeholder="Search a product, or scan a code and press Enter…   (F2)"
          className="min-h-12 w-full rounded-xl border border-line bg-surface pr-24 pl-11 text-base text-fg-strong focus:border-indigo-500 focus:outline-none"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setNote(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void enter();
            }
          }}
        />
        <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1">
          <ScanLine className="size-5 text-fg-subtle" aria-hidden />
          {query === '' ? null : (
            <button type="button" aria-label="Clear the search" className="inline-flex size-9 items-center justify-center rounded-lg text-fg-muted hover:bg-hover" onClick={() => { setQuery(''); searchRef.current?.focus(); }}>
              <X className="size-5" aria-hidden />
            </button>
          )}
        </div>
      </div>
      {note === null ? null : <p role="status" className="text-sm text-fg-muted" data-testid="till-note">{note}</p>}

      <div className="flex max-h-24 flex-wrap gap-2 overflow-y-auto" role="group" aria-label="Categories">
        <Chip active={category === null} onClick={() => setCategory(null)}>All</Chip>
        {start.categories.map((c) => (
          <Chip key={c.id} active={category === c.id} onClick={() => setCategory(category === c.id ? null : c.id)}>{c.name}</Chip>
        ))}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1" data-testid="till-products">
        {showRecent ? (
          <section aria-label="Sold most often by you lately" className="space-y-2">
            <h2 className="text-xs font-bold tracking-wider text-fg-subtle uppercase">Your usual</h2>
            <TileGrid tiles={start.recent} inCart={inCart} onPick={onPick} compact />
          </section>
        ) : null}
        <section aria-label="Products" className="space-y-2">
          {showRecent ? <h2 className="text-xs font-bold tracking-wider text-fg-subtle uppercase">All products</h2> : null}
          {tiles.length === 0 && !loading ? <p className="py-8 text-center text-sm text-fg-muted" data-testid="till-no-products">{wanted === '' ? 'Nothing to sell here yet.' : `Nothing found for “${wanted}”.`}</p> : <TileGrid tiles={tiles} inCart={inCart} onPick={onPick} />}
          {problem === null ? null : <p role="alert" className="text-sm text-red-700">{problem}</p>}
          {next === null ? null : <button type="button" className="min-h-11 w-full rounded-xl border border-line text-sm font-semibold text-fg hover:bg-hover disabled:opacity-60" disabled={loading} onClick={() => void more()}>{loading ? 'Loading…' : 'Show more'}</button>}
        </section>
      </div>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={`min-h-10 cursor-pointer rounded-full border px-4 text-sm font-semibold ${active ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-line bg-surface text-fg hover:bg-hover'}`}>
      {children}
    </button>
  );
}

function TileGrid({ tiles, inCart, onPick, compact = false }: { tiles: CounterTile[]; inCart: ReadonlyMap<string, number>; onPick: (tile: CounterTile) => void; compact?: boolean }) {
  return (
    <ul className={`grid gap-3 ${compact ? 'grid-cols-3 sm:grid-cols-4 xl:grid-cols-6' : 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6'}`}>
      {tiles.map((t) => (
        <li key={t.id}>
          <Tile tile={t} count={inCart.get(t.id) ?? 0} onPick={onPick} />
        </li>
      ))}
    </ul>
  );
}

function Tile({ tile, count, onPick }: { tile: CounterTile; count: number; onPick: (tile: CounterTile) => void }) {
  const out = tile.inStock !== null && tile.inStock <= 0;
  const hue = hueOf(tile.name);
  return (
    <button
      type="button"
      data-testid="till-tile"
      disabled={out || tile.price === null}
      onClick={() => onPick(tile)}
      aria-label={`${tile.name}, ${tile.price === null ? 'no price' : kes(tile.price)}${out ? ', out of stock' : ''}${count > 0 ? `, ${String(count)} in the sale` : ''}`}
      className="group relative flex min-h-11 w-full cursor-pointer flex-col overflow-hidden rounded-xl border border-line bg-surface-raised text-left transition active:scale-[0.97] hover:border-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="relative block w-full aspect-[4/3]" style={{ background: `hsl(${String(hue)} 55% 88%)` }}>
        {tile.imageUrl === '' ? (
          <span className="absolute inset-0 flex items-center justify-center text-3xl font-bold" style={{ color: `hsl(${String(hue)} 45% 32%)` }} aria-hidden>{tile.isPackage ? <Package className="size-8" /> : initials(tile.name)}</span>
        ) : (
          <AppImage src={tile.imageUrl} alt="" fill sizes="(min-width: 1280px) 12vw, 30vw" className="object-cover" />
        )}
        {count > 0 ? <span className="absolute top-2 right-2 inline-flex min-w-7 items-center justify-center rounded-full bg-indigo-600 px-2 py-0.5 text-xs font-bold text-white" data-testid="tile-count">{count}</span> : null}
        <StockBadge out={out} low={tile.lowStock} left={tile.inStock} />
      </span>
      <span className="flex flex-1 flex-col gap-0.5 p-2.5">
        <span className="line-clamp-2 text-sm leading-snug font-semibold text-fg-strong">{tile.name}</span>
        <span className="text-sm font-bold text-indigo-700">{tile.price === null ? 'No price' : kes(tile.price)}{tile.isPackage ? ' · choose' : ''}</span>
      </span>
    </button>
  );
}

function StockBadge({ out, low, left }: { out: boolean; low: boolean; left: number | null }) {
  if (out) return <span className="absolute bottom-2 left-2 rounded-md bg-red-600 px-2 py-0.5 text-[11px] font-bold text-white">Out</span>;
  if (low) return <span className="absolute bottom-2 left-2 rounded-md bg-amber-500 px-2 py-0.5 text-[11px] font-bold text-white">Low · {left}</span>;
  return null;
}
