'use client';

import { useRef, useState } from 'react';
import { ChevronDown, ChevronUp, GripVertical, Plus, X } from 'lucide-react';
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
}

type Dragging = { kind: 'line'; index: number } | { kind: 'section'; id: string } | null;
type Hint = { key: string; after?: boolean } | null;

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
  noun,
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
  noun: 'quote' | 'template';
}) {
  const dragging = useRef<Dragging>(null);
  const [hint, setHint] = useState<Hint>(null);
  const [said, setSaid] = useState('');

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
    const rows = lines.flatMap((line, index) =>
      (line.sectionId ?? null) === slot ? [{ line, index }] : [],
    );
    return (
      <div className="overflow-x-auto" {...slotTarget(slot)}>
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
                className={lineShadow(index)}
                {...lineTarget(index)}
              >
                <td className="p-1 align-top">
                  <div className="flex items-center">
                    <button
                      type="button"
                      draggable
                      onDragStart={(e) =>
                        startDrag({ kind: 'line', index }, e, e.currentTarget.closest('tr'))
                      }
                      onDragEnd={end}
                      className={`${iconButton} cursor-grab active:cursor-grabbing`}
                      aria-label={`Drag ${lineName(line)} to move it`}
                      title="Drag to move. The arrows move it one place."
                    >
                      <GripVertical className="h-4 w-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      className={iconButton}
                      disabled={!canNudgeLine(lines, sections, index, -1)}
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
                      disabled={!canNudgeLine(lines, sections, index, 1)}
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
      </div>
    );
  };

  const patchSection = (id: string, patch: Partial<BoardSection>) =>
    onChange({ sections: sections.map((s) => (s.id === id ? { ...s, ...patch } : s)), lines });

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-prose text-xs text-fg-muted">
          Drag an item by its grip, or use the arrows, to put it where you want it: in this list, in
          a section, or in another section. Sections can be moved the same way.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onBrowse(null)}
            className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-indigo-300"
          >
            <Plus className="h-4 w-4" aria-hidden /> Add {noun === 'quote' ? 'quote item' : 'item'}
          </button>
          <button
            type="button"
            onClick={() =>
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
              })
            }
            className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm font-medium text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500"
          >
            <Plus className="h-4 w-4" aria-hidden /> Add section
          </button>
        </div>
      </header>

      <article
        aria-label="Individual items"
        className={`overflow-hidden rounded-xl border border-line bg-surface ${slotRing(null)}`}
        {...slotTarget(null)}
      >
        <header className="border-b border-line bg-surface-raised p-3">
          <h4 className="font-semibold text-fg-strong">Individual items</h4>
          <p className="text-xs text-fg-muted">
            These print one by one, ahead of the sections. Drop an item here to take it out of a section.
          </p>
        </header>
        {table(null, 'No individual items. Add one, or drag an item here.')}
      </article>

      {sections.map((section, sIndex) => {
        const total = sectionTotal?.(section.id) ?? null;
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
            className={`overflow-hidden rounded-xl border border-line bg-surface ${slotRing(section.id)} ${shadow}`}
            {...sectionTarget(section.id)}
          >
            <header className="space-y-2 border-b border-line bg-surface-raised p-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex shrink-0 items-center">
                  <button
                    type="button"
                    draggable
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
                    title="Drag to move the section. The arrows move it one place."
                  >
                    <GripVertical className="h-4 w-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    className={iconButton}
                    disabled={sIndex === 0}
                    onClick={() => changeSections(nudgeSection(sections, sIndex, -1), section.id)}
                    aria-label={`Move section ${section.title} up`}
                  >
                    <ChevronUp className="h-4 w-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    className={iconButton}
                    disabled={sIndex === sections.length - 1}
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
                {total != null && (
                  <span className="shrink-0 rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold text-indigo-800">
                    Section total {total}
                  </span>
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
              </div>
              <div>
                <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={section.showLines === true}
                    onChange={(e) => patchSection(section.id, { showLines: e.target.checked })}
                  />
                  Keep this section expanded on the printout
                </label>
              </div>
              <input
                value={section.description ?? ''}
                onChange={(e) => patchSection(section.id, { description: e.target.value })}
                placeholder="Optional section description"
                aria-label="Section description"
                className="min-h-10 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg"
              />
            </header>
            {table(
              section.id,
              'No items in this section yet. Browse the catalogue, or drag an item here.',
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
