'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical, Trash2 } from 'lucide-react';
import type { ProductSpecification } from '@/types/index';
import {
  moveSpecification,
  PRODUCT_SPECIFICATION_KEY_MAX_LENGTH,
  PRODUCT_SPECIFICATION_VALUE_MAX_LENGTH,
} from '@/lib/product-specifications';

export type EditableProductSpecification = ProductSpecification & { rowId: string };

const fieldClass =
  'block min-h-10 w-full min-w-0 rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong focus-visible:outline-2 focus-visible:outline-indigo-500';
const iconButton =
  'inline-flex min-h-10 min-w-10 cursor-pointer items-center justify-center rounded-lg text-fg-subtle hover:bg-hover hover:text-fg-strong disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent';

/**
 * The product's specifications as an ordered list. The order is what shoppers see, so it can be changed three ways: drag a row by its
 * handle (mouse and pen), or use Move up / Move down (keyboard, touch, screen readers). Nothing here saves: the editor does, on Save.
 */
export function ProductSpecificationList({
  specifications,
  onChange,
}: {
  specifications: EditableProductSpecification[];
  onChange: (next: EditableProductSpecification[]) => void;
}) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState('');
  // After a button move the row has a new place; keep the keyboard on the same button so it can be pressed again.
  const refocus = useRef<{ rowId: string; direction: 'up' | 'down' } | null>(null);

  useEffect(() => {
    const target = refocus.current;
    if (target === null) return;
    refocus.current = null;
    const index = specifications.findIndex((s) => s.rowId === target.rowId);
    const preferred = document.getElementById(`spec-${target.direction}-${target.rowId}`);
    const other = document.getElementById(`spec-${target.direction === 'up' ? 'down' : 'up'}-${target.rowId}`);
    const atEdge = target.direction === 'up' ? index === 0 : index === specifications.length - 1;
    (atEdge ? other : preferred)?.focus();
  }, [specifications]);

  const move = (from: number, to: number, via: 'drag' | 'button') => {
    const row = specifications[from];
    if (row === undefined) return;
    const next = moveSpecification(specifications, from, to);
    if (next.every((r, i) => r === specifications[i])) return;
    if (via === 'button') refocus.current = { rowId: row.rowId, direction: to < from ? 'up' : 'down' };
    onChange(next);
    const name = row.key.trim() === '' ? 'Specification' : row.key.trim();
    setAnnouncement(`${name} moved to position ${String(to + 1)} of ${String(specifications.length)}.`);
  };

  const update = (index: number, field: keyof ProductSpecification, value: string) =>
    onChange(specifications.map((spec, i) => (i === index ? { ...spec, [field]: value } : spec)));
  const remove = (index: number) => onChange(specifications.filter((_, i) => i !== index));
  const endDrag = () => {
    setDragFrom(null);
    setDragOver(null);
  };

  return (
    <>
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
      <ul className="space-y-2" aria-label="Specifications, in the order shoppers see them">
        {specifications.map((spec, idx) => (
          <li
            key={spec.rowId}
            onDragOver={(event) => {
              if (dragFrom === null) return;
              event.preventDefault();
              if (dragOver !== idx) setDragOver(idx);
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragFrom !== null) move(dragFrom, idx, 'drag');
              endDrag();
            }}
            className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border bg-surface p-2 sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,1.5fr)_auto] ${
              dragOver === idx && dragFrom !== null && dragFrom !== idx ? 'border-indigo-500 bg-indigo-600/10' : 'border-line'
            } ${dragFrom === idx ? 'opacity-50' : ''}`}
          >
            <span
              draggable
              onDragStart={(event) => {
                const { dataTransfer } = event;
                dataTransfer.effectAllowed = 'move';
                dataTransfer.setData('text/plain', spec.rowId);
                setDragFrom(idx);
              }}
              onDragEnd={endDrag}
              title="Drag to reorder"
              aria-hidden="true"
              className="inline-flex min-h-10 min-w-8 cursor-grab touch-none items-center justify-center text-fg-subtle active:cursor-grabbing"
            >
              <GripVertical className="h-4 w-4" />
            </span>
            <input
              type="text"
              aria-label={`Specification name ${String(idx + 1)}`}
              value={spec.key}
              onChange={(event) => update(idx, 'key', event.target.value)}
              maxLength={PRODUCT_SPECIFICATION_KEY_MAX_LENGTH}
              className={fieldClass}
            />
            <div className="col-span-3 row-start-2 sm:col-span-1 sm:col-start-3 sm:row-start-auto">
              <input
                type="text"
                aria-label={`Specification value ${String(idx + 1)}`}
                value={spec.value}
                onChange={(event) => update(idx, 'value', event.target.value)}
                maxLength={PRODUCT_SPECIFICATION_VALUE_MAX_LENGTH}
                className={fieldClass}
              />
            </div>
            <div className="flex items-center">
              <button
                type="button"
                id={`spec-up-${spec.rowId}`}
                onClick={() => move(idx, idx - 1, 'button')}
                disabled={idx === 0}
                aria-label={`Move ${spec.key.trim() === '' ? `specification ${String(idx + 1)}` : spec.key.trim()} up`}
                className={iconButton}
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                id={`spec-down-${spec.rowId}`}
                onClick={() => move(idx, idx + 1, 'button')}
                disabled={idx === specifications.length - 1}
                aria-label={`Move ${spec.key.trim() === '' ? `specification ${String(idx + 1)}` : spec.key.trim()} down`}
                className={iconButton}
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => remove(idx)}
                aria-label={`Remove ${spec.key}`}
                className={`${iconButton} hover:bg-red-50 hover:text-red-600`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
