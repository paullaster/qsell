'use client';

import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, GripVertical, Heading2, AlignLeft } from 'lucide-react';
import {
  createEmptyDescriptionSection,
  parseProductDescription,
  serializeProductDescription,
  type ProductDescriptionSection,
} from '@/lib/productDescription';

interface ProductDescriptionEditorProps {
  value: string;
  onChange: (next: string) => void;
  className?: string;
}

export function ProductDescriptionEditor({
  value,
  onChange,
  className = '',
}: ProductDescriptionEditorProps) {
  const [sections, setSections] = useState<ProductDescriptionSection[]>(() =>
    parseProductDescription(value),
  );
  const lastSerialized = useRef(serializeProductDescription(sections));

  // Sync when parent resets the form (open create/edit) without fighting local edits.
  useEffect(() => {
    const incoming = typeof value === 'string' ? value : '';
    if (incoming === lastSerialized.current) return;
    const parsed = parseProductDescription(incoming);
    setSections(parsed);
    lastSerialized.current = serializeProductDescription(parsed);
  }, [value]);

  const commit = (next: ProductDescriptionSection[]) => {
    setSections(next);
    const serialized = serializeProductDescription(next);
    lastSerialized.current = serialized;
    onChange(serialized);
  };

  const updateSection = (
    id: string,
    patch: Partial<Pick<ProductDescriptionSection, 'heading' | 'body'>>,
  ) => {
    commit(sections.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  const addSection = () => {
    commit([...sections, createEmptyDescriptionSection()]);
  };

  const removeSection = (id: string) => {
    const next = sections.filter((s) => s.id !== id);
    commit(next.length > 0 ? next : [createEmptyDescriptionSection()]);
  };

  const moveSection = (id: string, direction: -1 | 1) => {
    const index = sections.findIndex((s) => s.id === id);
    if (index < 0) return;
    const target = index + direction;
    if (target < 0 || target >= sections.length) return;
    const next = [...sections];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    commit(next);
  };

  return (
    <div className={`space-y-3 ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold tracking-wider text-fg-muted uppercase">
            Structured description
          </p>
          <p className="mt-0.5 text-[11px] text-fg-subtle">
            Add a subheading and content below it. Repeat as needed — everything saves as one
            description.
          </p>
        </div>
        <button
          type="button"
          onClick={addSection}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
        >
          <Plus className="h-3.5 w-3.5" />
          Add section
        </button>
      </div>

      <div className="max-h-[min(420px,50vh)] space-y-3 overflow-y-auto pr-1">
        {sections.map((section, index) => (
          <div
            key={section.id}
            className="rounded-xl border border-line bg-surface/80 p-3 shadow-sm"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-fg-subtle uppercase">
                <GripVertical className="h-3.5 w-3.5 text-fg-faint" />
                Section {index + 1}
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => moveSection(section.id, -1)}
                  disabled={index === 0}
                  className="rounded px-2 py-1 text-[10px] font-medium text-fg-muted hover:bg-hover hover:text-fg-strong disabled:opacity-30"
                >
                  Up
                </button>
                <button
                  type="button"
                  onClick={() => moveSection(section.id, 1)}
                  disabled={index === sections.length - 1}
                  className="rounded px-2 py-1 text-[10px] font-medium text-fg-muted hover:bg-hover hover:text-fg-strong disabled:opacity-30"
                >
                  Down
                </button>
                <button
                  type="button"
                  onClick={() => removeSection(section.id)}
                  className="rounded p-1.5 text-fg-subtle hover:bg-hover hover:text-red-600"
                  aria-label={`Remove section ${index + 1}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <label className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-fg-muted">
              <Heading2 className="h-3.5 w-3.5 text-indigo-400" />
              Subheading
            </label>
            <input
              type="text"
              value={section.heading}
              onChange={(e) => updateSection(section.id, { heading: e.target.value })}
              placeholder="e.g. Package, What you can power, Warranty"
              className="mb-3 w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm font-semibold text-fg-strong placeholder-fg-faint focus:border-indigo-500 focus:outline-none"
            />

            <label className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-fg-muted">
              <AlignLeft className="h-3.5 w-3.5 text-indigo-400" />
              Content
            </label>
            <textarea
              value={section.body}
              onChange={(e) => updateSection(section.id, { body: e.target.value })}
              rows={4}
              placeholder="Write the details for this subheading…"
              className="w-full resize-y rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm leading-relaxed text-fg-strong placeholder-fg-faint focus:border-indigo-500 focus:outline-none"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
