'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ClipboardPaste,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  GripVertical,
  Plus,
  Search,
  X,
} from 'lucide-react';
import {
  canNudgeLine,
  dropLine,
  dropSection,
  nudgeLine,
  nudgeSection,
  placeOf,
  removeSection,
  type Placed,
  type Slot,
} from '@/lib/quote-layout';

export interface BoardSection {
  id: string;
  title: string;
  description?: string | null;
  showLines?: boolean;
  /** The section template this section was made from, on a quote. */
  sectionTemplateId?: string | null;
}

/** A section template a quote's sections can be made from. */
export interface SectionTemplateOption {
  id: string;
  name: string;
  status: string;
}

type Dragging = { kind: 'line'; index: number } | { kind: 'section'; id: string } | null;
type Hint = { key: string; after?: boolean } | null;

/** A place with this many lines or more starts collapsed. */
const LARGE = 30;
/** Rows drawn at once in one place; the rest come in steps, so a huge list stays quick. */
const ROW_PAGE = 50;
/** From this many lines, the list gets a search box and expand/collapse all. */
const FIND_AT = 10;
/** More lines than this arriving in one change count as a batch. */
const BATCH = 20;

const iconButton =
  'inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent';

/** Which half of an element the pointer is over. */
const lowerHalf = (e: React.DragEvent, el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return e.clientY > r.top + r.height / 2;
};

/**
 * Quote and template items are arranged into titled sections. Items and sections can be rearranged
 * by dragging or with arrow buttons (which also work by keyboard and on a phone).
 *
 * It owns the layout, not the columns: the caller says what a row's cells are.
 */
export function QuoteLayoutBoard<L extends Placed, S extends BoardSection>({
  sections,
  lines,
  onChange,
  head,
  columns,
  minWidth,
  renderCells,
  lineName,
  sectionTotal,
  onBrowse,
  focusLine,
  quickAdd,
  lineSearchText,
  onBulkAdd,
  noun,
  sectionTemplates,
  onAddSectionFromTemplate,
  onSectionTemplateChange,
  flat = false,
}: {
  sections: S[];
  lines: L[];
  onChange: (next: { sections: S[]; lines: L[] }) => void;
  /** The `<th>` cells for the item columns (the move column and the trailing one are added here). */
  head: React.ReactNode;
  /** How many cells `renderCells` gives, for the width of messages that span the table. */
  columns: number;
  minWidth: number;
  renderCells: (line: L, index: number) => React.ReactNode;
  lineName: (line: L) => string;
  sectionTotal?: (sectionId: string) => string | null;
  onBrowse: (sectionId: string | null) => void;
  /**
   * Scrolls to a line, focuses its first field and marks it for a moment. A new `nonce` asks again
   * for the same line.
   */
  focusLine?: { index: number; nonce: number } | null;
  /** A quick-add bar for one place, shown under its header while it is open. */
  quickAdd?: (slot: Slot) => React.ReactNode;
  /** Opens the paste-a-list dialog. */
  onBulkAdd?: () => void;
  /** What "find in this list" looks at for a line. Defaults to its name. */
  lineSearchText?: (line: L) => string;
  noun: 'quote' | 'template';
  /**
   * Section templates, on a quote. With them, "Add section" offers a new empty section or one made
   * from a template, and each section can switch its template.
   */
  sectionTemplates?: SectionTemplateOption[];
  onAddSectionFromTemplate?: (templateId: string) => void;
  /** An empty id removes the section's template. */
  onSectionTemplateChange?: (sectionId: string, templateId: string) => void;
  /** One plain list of items with no sections, as in a section template. */
  flat?: boolean;
}) {
  const dragging = useRef<Dragging>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [pickTemplate, setPickTemplate] = useState('');
  const activeSectionTemplates = (sectionTemplates ?? []).filter((t) => t.status === 'active');
  const addEmptySection = () =>
    onChange({
      sections: [
        ...sections,
        {
          id: crypto.randomUUID(),
          title: `Section ${sections.length + 1}`,
          description: '',
          showLines: false,
        } as S,
      ],
      lines,
    });
  const [hint, setHint] = useState<Hint>(null);
  const [said, setSaid] = useState('');
  const [flash, setFlash] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const filtering = query.trim() !== '';
  const reordering = !filtering;

  /** Collapsed places by key; a place with no entry follows the default. */
  const keyOf = (slot: Slot) => slot ?? '__none';
  const countIn = (slot: Slot) =>
    lines.reduce((n, l) => n + ((l.sectionId ?? null) === slot ? 1 : 0), 0);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      [null, ...sections.map((s) => s.id)]
        .filter((slot) => countIn(slot) >= LARGE)
        .map((slot) => [keyOf(slot), true]),
    ),
  );
  const [rowLimit, setRowLimit] = useState<Record<string, number>>({});
  const limitOf = (slot: Slot) => rowLimit[keyOf(slot)] ?? ROW_PAGE;
  const isCollapsed = (slot: Slot) => !filtering && collapsed[keyOf(slot)] === true;
  const setOpen = (slot: Slot, open: boolean) =>
    setCollapsed((current) => ({ ...current, [keyOf(slot)]: !open }));

  // A big batch arriving at once (a quote applied to a template, say) opens collapsed rather than
  // drawing hundreds of rows. Items added one at a time never close the place being typed into.
  const lastCount = useRef(lines.length);
  useEffect(() => {
    const grew = lines.length - lastCount.current;
    lastCount.current = lines.length;
    if (grew <= BATCH) return;
    setCollapsed((current) => {
      const next = { ...current };
      for (const slot of [null, ...sections.map((s) => s.id)]) {
        if (!(keyOf(slot) in next) && countIn(slot) >= LARGE) next[keyOf(slot)] = true;
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the lines changing only
  }, [lines]);

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (line: L) => {
    if (words.length === 0) return true;
    const text = (lineSearchText ?? lineName)(line).toLowerCase();
    return words.every((w) => text.includes(w));
  };
  const matchCount = filtering ? lines.reduce((n, l) => n + (matches(l) ? 1 : 0), 0) : lines.length;

  // Takes the person to a line: opens the place it is in (and clears a search hiding it) first.
  const handled = useRef(0);
  useEffect(() => {
    if (!focusLine || handled.current === focusLine.nonce) return;
    const row = document.getElementById(`${noun}-line-${focusLine.index}`);
    if (!row) {
      const line = lines[focusLine.index];
      if (!line) return;
      const slot = line.sectionId ?? null;
      if (collapsed[keyOf(slot)]) {
        setOpen(slot, true);
        return;
      }
      if (query && !matches(line)) {
        setQuery('');
        return;
      }
      // Beyond the rows drawn so far: draw up to it.
      let rank = 0;
      for (let i = 0; i < focusLine.index; i++) {
        const other = lines[i]!;
        if ((other.sectionId ?? null) === slot && matches(other)) rank++;
      }
      if (rank >= limitOf(slot)) {
        setRowLimit((current) => ({ ...current, [keyOf(slot)]: rank + 1 }));
      }
      return;
    }
    handled.current = focusLine.nonce;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    row.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    row.querySelector<HTMLInputElement>('input, select')?.focus({ preventScroll: true });
    setFlash(focusLine.index);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs again after a place opens
  }, [focusLine, collapsed, query, rowLimit]);
  useEffect(() => {
    if (flash === null) return;
    const timer = window.setTimeout(() => setFlash(null), 2500);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const titleOf = (slot: Slot) =>
    slot === null
      ? 'the individual items'
      : `section ${sections.find((s) => s.id === slot)?.title || ''}`.trim();

  /** Applies a change to the lines and says, for screen readers, where the item ended up. */
  const changeLines = (next: L[], moved: string) => {
    if (next === lines) return;
    onChange({ sections, lines: next });
    const at = next.findIndex((l) => !lines.includes(l));
    if (at >= 0) {
      const p = placeOf(next, at);
      setSaid(`${moved} moved to ${titleOf(p.slot)}, place ${p.position + 1} of ${p.size}.`);
    }
  };
  const changeSections = (next: S[], id: string) => {
    if (next === sections) return;
    onChange({ sections: next, lines });
    const moved = next.find((s) => s.id === id);
    setSaid(
      `Section ${moved?.title ?? ''} is now number ${next.findIndex((s) => s.id === id) + 1} of ${next.length}.`,
    );
  };

  const end = () => {
    dragging.current = null;
    setHint(null);
  };
  const startDrag = (
    item: NonNullable<Dragging>,
    e: React.DragEvent,
    image: HTMLElement | null,
  ) => {
    dragging.current = item;
    e.dataTransfer.effectAllowed = 'move';
    // Firefox starts no drag without data.
    e.dataTransfer.setData('text/plain', item.kind === 'line' ? 'line' : 'section');
    if (image) e.dataTransfer.setDragImage(image, 16, 16);
  };

  const lineTarget = (index: number) => ({
    onDragOver: (e: React.DragEvent<HTMLElement>) => {
      if (dragging.current?.kind !== 'line') return;
      e.preventDefault();
      e.stopPropagation();
      setHint({ key: `line-${index}`, after: lowerHalf(e, e.currentTarget) });
    },
    onDrop: (e: React.DragEvent<HTMLElement>) => {
      if (dragging.current?.kind !== 'line') return;
      e.preventDefault();
      e.stopPropagation();
      const from = dragging.current.index;
      const after = lowerHalf(e, e.currentTarget);
      end();
      changeLines(dropLine(lines, from, { kind: 'line', index, after }), lineName(lines[from]!));
    },
  });
  const slotTarget = (slot: Slot) => ({
    onDragOver: (e: React.DragEvent<HTMLElement>) => {
      if (dragging.current?.kind !== 'line') return;
      e.preventDefault();
      setHint({ key: `slot-${slot ?? 'none'}` });
    },
    onDrop: (e: React.DragEvent<HTMLElement>) => {
      if (dragging.current?.kind !== 'line') return;
      e.preventDefault();
      const from = dragging.current.index;
      end();
      changeLines(dropLine(lines, from, { kind: 'slot', slot }), lineName(lines[from]!));
    },
  });
  const sectionTarget = (id: string) => ({
    onDragOver: (e: React.DragEvent<HTMLElement>) => {
      const d = dragging.current;
      if (d?.kind === 'section') {
        if (d.id === id) return;
        e.preventDefault();
        setHint({ key: `section-${id}`, after: lowerHalf(e, e.currentTarget) });
      } else if (d?.kind === 'line') {
        e.preventDefault();
        setHint({ key: `slot-${id}` });
      }
    },
    onDrop: (e: React.DragEvent<HTMLElement>) => {
      const d = dragging.current;
      if (!d) return;
      e.preventDefault();
      if (d.kind === 'section') {
        const after = lowerHalf(e, e.currentTarget);
        end();
        changeSections(dropSection(sections, d.id, id, after), d.id);
      } else {
        const from = d.index;
        end();
        changeLines(dropLine(lines, from, { kind: 'slot', slot: id }), lineName(lines[from]!));
      }
    },
  });

  const lineShadow = (index: number) =>
    hint?.key === `line-${index}`
      ? hint.after
        ? 'shadow-[inset_0_-3px_0_0_#6366f1]'
        : 'shadow-[inset_0_3px_0_0_#6366f1]'
      : '';
  const slotRing = (slot: Slot) =>
    hint?.key === `slot-${slot ?? 'none'}` ? 'ring-2 ring-indigo-400' : '';

  const table = (slot: Slot, empty: string) => {
    const all = lines.flatMap((line, index) =>
      (line.sectionId ?? null) === slot && matches(line) ? [{ line, index }] : [],
    );
    const limit = limitOf(slot);
    const rows = all.slice(0, limit);
    const more = all.length - rows.length;
    return (
      <div className="relative overflow-x-auto" {...slotTarget(slot)}>
        <table className="w-full text-left text-sm" style={{ minWidth }}>
          <thead className="bg-surface text-xs text-fg-muted">
            <tr>
              <th className="w-[7.5rem] p-2">
                <span className="sr-only">Move</span>
              </th>
              {head}
              <th>
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map(({ line, index }) => (
              <tr
                key={`${slot ?? 'none'}-${index}-${lineName(line)}`}
                id={`${noun}-line-${index}`}
                className={`${lineShadow(index)} ${flash === index ? 'bg-emerald-50 outline-2 -outline-offset-2 outline-emerald-500 dark:bg-emerald-950/30' : ''}`}
                {...lineTarget(index)}
              >
                <td className="p-1 align-top">
                  <div className="flex items-center">
                    <button
                      type="button"
                      draggable={reordering}
                      disabled={!reordering}
                      onDragStart={(e) =>
                        startDrag({ kind: 'line', index }, e, e.currentTarget.closest('tr'))
                      }
                      onDragEnd={end}
                      className={`${iconButton} cursor-grab active:cursor-grabbing`}
                      aria-label={`Drag ${lineName(line)} to move it`}
                      title={
                        reordering
                          ? 'Drag to move. The arrows move it one place.'
                          : 'Clear the search to move items.'
                      }
                    >
                      <GripVertical className="h-4 w-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      className={iconButton}
                      disabled={!reordering || !canNudgeLine(lines, sections, index, -1)}
                      onClick={() =>
                        changeLines(nudgeLine(lines, sections, index, -1), lineName(line))
                      }
                      aria-label={`Move ${lineName(line)} up`}
                    >
                      <ChevronUp className="h-4 w-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      className={iconButton}
                      disabled={!reordering || !canNudgeLine(lines, sections, index, 1)}
                      onClick={() =>
                        changeLines(nudgeLine(lines, sections, index, 1), lineName(line))
                      }
                      aria-label={`Move ${lineName(line)} down`}
                    >
                      <ChevronDown className="h-4 w-4" aria-hidden />
                    </button>
                  </div>
                </td>
                {renderCells(line, index)}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns + 1} className="p-6 text-center text-sm text-fg-muted">
                  {empty}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {more > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-surface-raised p-3">
            <p className="text-xs text-fg-muted" role="status">
              Showing {rows.length.toLocaleString()} of {all.length.toLocaleString()} items here.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() =>
                  setRowLimit((current) => ({ ...current, [keyOf(slot)]: limit + ROW_PAGE }))
                }
                className="min-h-10 cursor-pointer rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm font-medium text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500"
              >
                Show {Math.min(ROW_PAGE, more)} more
              </button>
              <button
                type="button"
                onClick={() =>
                  setRowLimit((current) => ({ ...current, [keyOf(slot)]: all.length }))
                }
                className="min-h-10 cursor-pointer rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm font-medium text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500"
              >
                Show all {all.length.toLocaleString()}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  const patchSection = (id: string, patch: Partial<BoardSection>) =>
    onChange({ sections: sections.map((s) => (s.id === id ? { ...s, ...patch } : s)), lines });

  const allSlots: Slot[] = [null, ...sections.map((s) => s.id)];
  const setAllOpen = (open: boolean) =>
    setCollapsed(Object.fromEntries(allSlots.map((slot) => [keyOf(slot), !open])));

  /** Toggle for a place's body; the button names what it controls. */
  const toggle = (slot: Slot, label: string) => {
    const closed = isCollapsed(slot);
    return (
      <button
        type="button"
        onClick={() => setOpen(slot, closed)}
        disabled={filtering}
        aria-expanded={!closed}
        aria-controls={`${noun}-body-${keyOf(slot)}`}
        aria-label={`${closed ? 'Expand' : 'Collapse'} ${label}`}
        title={filtering ? 'Places stay open while you search.' : closed ? 'Expand' : 'Collapse'}
        className={iconButton}
      >
        {closed ? (
          <ChevronRight className="h-4 w-4" aria-hidden />
        ) : (
          <ChevronDown className="h-4 w-4" aria-hidden />
        )}
      </button>
    );
  };

  const count = (slot: Slot) => {
    const n = countIn(slot);
    return `${n} ${n === 1 ? 'item' : 'items'}`;
  };

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-prose text-xs text-fg-muted">
          {flat
            ? 'Drag an item by its grip, or use the arrows, to put it where you want it in the list.'
            : 'Drag an item by its grip, or use the arrows, to put it where you want it: in this list, in a section, or in another section. Sections can be moved the same way.'}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onBrowse(null)}
            className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-indigo-300"
          >
            <Plus className="h-4 w-4" aria-hidden /> Add {noun === 'quote' ? 'quote item' : 'item'}
          </button>
          {!flat && (
            <button
              type="button"
              onClick={() =>
                onAddSectionFromTemplate ? setAddOpen((open) => !open) : addEmptySection()
              }
              aria-expanded={onAddSectionFromTemplate ? addOpen : undefined}
              aria-controls={onAddSectionFromTemplate ? `${noun}-add-section` : undefined}
              className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm font-medium text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500"
            >
              <Plus className="h-4 w-4" aria-hidden /> Add section
            </button>
          )}
          {onBulkAdd && (
            <button
              type="button"
              onClick={onBulkAdd}
              className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm font-medium text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500"
            >
              <ClipboardPaste className="h-4 w-4" aria-hidden /> Paste or import list
            </button>
          )}
        </div>
      </header>

      {addOpen && onAddSectionFromTemplate && (
        <div
          id={`${noun}-add-section`}
          role="group"
          aria-label="Add a section"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setAddOpen(false);
          }}
          className="grid gap-3 rounded-xl border border-line bg-surface-raised p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-end"
        >
          <button
            type="button"
            onClick={() => {
              addEmptySection();
              setAddOpen(false);
            }}
            className="min-h-10 cursor-pointer rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm font-medium text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500"
          >
            New empty section
          </button>
          <label className="text-sm font-medium text-fg">
            Or from a section template
            <select
              value={pickTemplate}
              onChange={(e) => setPickTemplate(e.target.value)}
              className="mt-1 block min-h-10 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong focus-visible:outline-2 focus-visible:outline-indigo-500"
            >
              <option value="">
                {activeSectionTemplates.length === 0
                  ? 'No section templates yet'
                  : 'Choose a section template…'}
              </option>
              {activeSectionTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!pickTemplate}
            onClick={() => {
              onAddSectionFromTemplate(pickTemplate);
              setPickTemplate('');
              setAddOpen(false);
            }}
            className="min-h-10 cursor-pointer rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-indigo-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Add section from template
          </button>
        </div>
      )}

      {lines.length >= FIND_AT && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-52 flex-1">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-fg-subtle"
              aria-hidden
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={`Find an item in this ${noun}`}
              placeholder={`Find an item in this ${noun}…`}
              className="min-h-10 w-full rounded-lg border border-line bg-surface py-2 pr-3 pl-9 text-sm text-fg-strong focus-visible:outline-2 focus-visible:outline-indigo-500"
            />
          </div>
          <button
            type="button"
            onClick={() => setAllOpen(true)}
            disabled={filtering}
            className="min-h-10 cursor-pointer rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm font-medium text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Expand all
          </button>
          <button
            type="button"
            onClick={() => setAllOpen(false)}
            disabled={filtering}
            className="min-h-10 cursor-pointer rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm font-medium text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Collapse all
          </button>
          <p role="status" aria-live="polite" className="w-full text-xs text-fg-muted">
            {filtering
              ? matchCount === 0
                ? 'No item matches. Clear the search to see them all.'
                : `Showing ${matchCount.toLocaleString()} of ${lines.length.toLocaleString()} items. Moving items is off while you search.`
              : `${lines.length.toLocaleString()} items in all.`}
          </p>
        </div>
      )}

      {(!filtering || lines.some((l) => (l.sectionId ?? null) === null && matches(l))) && (
        <article
          aria-label="Individual items"
          className={`overflow-clip rounded-xl border border-line bg-surface ${slotRing(null)}`}
          {...slotTarget(null)}
        >
          <header className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-surface-raised p-3">
            {toggle(null, 'the individual items')}
            <div className="min-w-0 flex-1">
              <h4 className="font-semibold text-fg-strong">
                {flat ? 'Items' : 'Individual items'}{' '}
                <span className="font-normal text-fg-muted">· {count(null)}</span>
              </h4>
              {!flat && !isCollapsed(null) && (
                <p className="text-xs text-fg-muted">
                  These print one by one, ahead of the sections. Drop an item here to take it out of
                  a section.
                </p>
              )}
            </div>
          </header>
          {!isCollapsed(null) && (
            <div id={`${noun}-body-${keyOf(null)}`}>
              {quickAdd?.(null)}
              {table(null, 'No individual items. Add one, or drag an item here.')}
            </div>
          )}
        </article>
      )}

      {sections.map((section, sIndex) => {
        if (filtering && !lines.some((l) => l.sectionId === section.id && matches(l))) return null;
        const total = sectionTotal?.(section.id) ?? null;
        const closed = isCollapsed(section.id);
        const shadow =
          hint?.key === `section-${section.id}`
            ? hint.after
              ? 'shadow-[0_3px_0_0_#6366f1]'
              : 'shadow-[0_-3px_0_0_#6366f1]'
            : '';
        return (
          <article
            key={section.id}
            aria-label={`Section ${section.title}`}
            className={`overflow-clip rounded-xl border border-line bg-surface ${slotRing(section.id)} ${shadow}`}
            {...sectionTarget(section.id)}
          >
            <header className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-surface-raised p-3">
              <div className="flex shrink-0 items-center">
                {toggle(section.id, `section ${section.title}`)}
                <button
                  type="button"
                  draggable={reordering}
                  disabled={!reordering}
                  onDragStart={(e) =>
                    startDrag(
                      { kind: 'section', id: section.id },
                      e,
                      e.currentTarget.closest('header'),
                    )
                  }
                  onDragEnd={end}
                  className={`${iconButton} cursor-grab active:cursor-grabbing`}
                  aria-label={`Drag section ${section.title} to move it`}
                  title={
                    reordering
                      ? 'Drag to move the section. The arrows move it one place.'
                      : 'Clear the search to move sections.'
                  }
                >
                  <GripVertical className="h-4 w-4" aria-hidden />
                </button>
                <button
                  type="button"
                  className={iconButton}
                  disabled={!reordering || sIndex === 0}
                  onClick={() => changeSections(nudgeSection(sections, sIndex, -1), section.id)}
                  aria-label={`Move section ${section.title} up`}
                >
                  <ChevronUp className="h-4 w-4" aria-hidden />
                </button>
                <button
                  type="button"
                  className={iconButton}
                  disabled={!reordering || sIndex === sections.length - 1}
                  onClick={() => changeSections(nudgeSection(sections, sIndex, 1), section.id)}
                  aria-label={`Move section ${section.title} down`}
                >
                  <ChevronDown className="h-4 w-4" aria-hidden />
                </button>
              </div>
              <input
                value={section.title}
                onChange={(e) => patchSection(section.id, { title: e.target.value })}
                className="min-h-10 min-w-40 flex-1 rounded-lg border border-line bg-surface px-3 py-2 font-semibold text-fg-strong"
                aria-label="Section title"
              />
              <span className="shrink-0 rounded-full bg-surface-sunken px-3 py-1 text-xs font-semibold text-fg">
                {count(section.id)}
              </span>
              {total != null && (
                <span className="shrink-0 rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold text-indigo-800">
                  Section total {total}
                </span>
              )}
              {sectionTemplates && onSectionTemplateChange && (
                <select
                  value={section.sectionTemplateId ?? ''}
                  onChange={(e) => onSectionTemplateChange(section.id, e.target.value)}
                  aria-label={`Template of section ${section.title}`}
                  className="min-h-10 max-w-full min-w-0 rounded-lg border border-line bg-surface px-2 py-2 text-sm text-fg-strong focus-visible:outline-2 focus-visible:outline-indigo-500 sm:max-w-56"
                >
                  <option value="">No section template</option>
                  {sectionTemplates
                    .filter((t) => t.status === 'active' || t.id === section.sectionTemplateId)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                        {t.status === 'archived' ? ' · Archived' : ''}
                      </option>
                    ))}
                </select>
              )}
              <button
                type="button"
                onClick={() => onBrowse(section.id)}
                className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-indigo-300"
              >
                <Plus className="h-4 w-4" aria-hidden /> Browse catalogue
              </button>
              <button
                type="button"
                onClick={() => onChange(removeSection(sections, lines, section.id))}
                className={`${iconButton} hover:bg-red-50 hover:text-red-700`}
                aria-label={`Remove section ${section.title} and move its items to another section`}
                title="Remove the section and move its items to another section"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </header>
            {!closed && (
              <div id={`${noun}-body-${section.id}`}>
                <div className="space-y-2 border-b border-line bg-surface-raised p-3">
                  <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={section.showLines === true}
                      onChange={(e) => patchSection(section.id, { showLines: e.target.checked })}
                    />
                    Keep this section expanded on the printout
                  </label>
                  <input
                    value={section.description ?? ''}
                    onChange={(e) => patchSection(section.id, { description: e.target.value })}
                    placeholder="Optional section description"
                    aria-label="Section description"
                    className="min-h-10 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg"
                  />
                </div>
                {quickAdd?.(section.id)}
                {table(
                  section.id,
                  'No items in this section yet. Browse the catalogue, or drag an item here.',
                )}
              </div>
            )}
          </article>
        );
      })}

      <p role="status" aria-live="polite" className="sr-only">
        {said}
      </p>
    </div>
  );
}
