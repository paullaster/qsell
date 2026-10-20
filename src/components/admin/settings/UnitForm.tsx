'use client';

import { useId, useState } from 'react';
import { createUnitAction, updateUnitAction, type UnitView } from '@/server/domains/units/actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { attempt, buttonClass, Field, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import {
  checkUnit,
  draftFromUnit,
  emptyUnitDraft,
  unitKindLabel,
  UNIT_KINDS,
  type UnitDraft,
} from '@/lib/unit-rules';
import { has } from '@/lib/values';
import { submitWords } from '@/lib/form-words';
import type { Choice } from '@/lib/payment-options';

const kindChoice = (kind: string): Choice => ({ id: kind, label: unitKindLabel(kind) });

/**
 * Makes a unit or changes one. The same form serves the list screen and the quick-create dialog.
 * What a unit in use means (family, base, factor) is locked here for convenience and again on the server.
 */
export function UnitForm({
  unit,
  onSaved,
  onCancel,
  autoFocus = false,
}: {
  unit: UnitView | null;
  onSaved: (saved: UnitView) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const uid = useId();
  const [draft, setDraft] = useState<UnitDraft>(() =>
    unit === null
      ? emptyUnitDraft()
      : draftFromUnit({ ...unit, kind: kindOf(unit.kind), factorToBase: unit.factorToBase }),
  );
  const [kind, setKind] = useState<Choice | null>(kindChoice(draft.kind));
  const [base, setBase] = useState<Choice | null>(
    unit?.baseUnitId == null
      ? null
      : { id: unit.baseUnitId, label: unit.baseUnitCode ?? unit.baseUnitId },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const locked = unit !== null && unit.usageWords !== null;
  const set = <K extends keyof UnitDraft>(key: K, value: UnitDraft[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));
  const isPackaging = kind?.id === 'packaging';

  const changeKind = (next: Choice | null) => {
    setKind(next);
    // A base unit belongs to one family: choosing another family starts over.
    setBase(null);
    setDraft((prev) => ({
      ...prev,
      kind: next?.id ?? prev.kind,
      baseUnitId: '',
      factorToBase: '1',
    }));
  };

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const sent: UnitDraft = {
      ...draft,
      kind: kind?.id ?? draft.kind,
      baseUnitId: isPackaging ? '' : (base?.id ?? ''),
    };
    const checked = checkUnit(sent);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setBusy(true);
    setError(null);
    const res =
      unit === null
        ? await attempt(createUnitAction(sent))
        : await attempt(updateUnitAction(unit.id, unit.version, sent));
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (res.data !== undefined) onSaved(res.data);
  };

  const title = unit === null ? 'New unit of measure' : `Edit ${unit.code}`;
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4" aria-label={title}>
      {error === null ? null : (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {locked ? (
        <p
          role="note"
          className="rounded-lg border border-line bg-surface-sunken px-3 py-2 text-xs text-fg-muted"
        >
          {unit.usageWords}. Its kind, base unit and factor are locked so saved quantities keep
          their meaning; you can still rename it, change its codes or add decimals.
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id={`${uid}-code`} label="Code" hint="Short and unique, for example KG or CRATE.">
          <input
            id={`${uid}-code`}
            value={draft.code}
            onChange={(e) => set('code', e.target.value)}
            className={`${fieldClass} font-mono uppercase`}
            maxLength={20}
            required
            autoFocus={autoFocus}
            autoComplete="off"
          />
        </Field>
        <Field id={`${uid}-name`} label="Name">
          <input
            id={`${uid}-name`}
            value={draft.name}
            onChange={(e) => set('name', e.target.value)}
            className={fieldClass}
            maxLength={80}
            required
            autoComplete="off"
          />
        </Field>
        <Field
          id={`${uid}-symbol`}
          label="Symbol (optional)"
          hint="Shown after quantities, for example kg."
        >
          <input
            id={`${uid}-symbol`}
            value={draft.symbol}
            onChange={(e) => set('symbol', e.target.value)}
            className={fieldClass}
            maxLength={12}
            autoComplete="off"
          />
        </Field>
        <Field
          id={`${uid}-decimals`}
          label="Decimals"
          hint="Digits allowed after the point: 0 for pieces, 3 for kilograms."
        >
          <input
            id={`${uid}-decimals`}
            type="number"
            min={0}
            max={3}
            step={1}
            inputMode="numeric"
            value={draft.decimals}
            onChange={(e) => set('decimals', e.target.value)}
            className={fieldClass}
            required
          />
        </Field>
        <ChoicePicker
          label="Kind"
          source="unit-kinds"
          choice={kind}
          onChoice={changeKind}
          clearable={false}
          required
          disabled={locked}
        />
        {isPackaging ? (
          <p className="self-end pb-2 text-xs text-fg-muted">
            A packaging unit holds a different amount for each product, so it is set on the product
            (1 CRATE = 20 KG).
          </p>
        ) : (
          <ChoicePicker
            label="Is a multiple of (leave empty for a base unit)"
            source="units-of-measure"
            filters={{
              bases: '1',
              ...(kind === null ? {} : { kind: kind.id }),
              ...(unit === null ? {} : { exclude: unit.id }),
            }}
            choice={base}
            onChoice={setBase}
            placeholder="None: this is a base unit"
            disabled={locked}
          />
        )}
        {!isPackaging && base !== null ? (
          <Field
            id={`${uid}-factor`}
            label={`How many ${baseCode(base)} make 1 ${has(draft.code) ? draft.code.toUpperCase() : 'of this unit'}`}
            hint="For example 0.001 for a gram when the base is the kilogram."
          >
            <input
              id={`${uid}-factor`}
              value={draft.factorToBase}
              onChange={(e) => set('factorToBase', e.target.value)}
              inputMode="decimal"
              className={`${fieldClass} font-mono`}
              disabled={locked}
              required
            />
          </Field>
        ) : null}
        <Field
          id={`${uid}-un`}
          label="International code (optional)"
          hint="UN/ECE Recommendation 20, for example KGM."
        >
          <input
            id={`${uid}-un`}
            value={draft.internationalCode}
            onChange={(e) => set('internationalCode', e.target.value)}
            className={`${fieldClass} font-mono uppercase`}
            maxLength={3}
            autoComplete="off"
          />
        </Field>
        <Field
          id={`${uid}-etims`}
          label="eTIMS code (optional)"
          hint="The quantity unit code KRA expects."
        >
          <input
            id={`${uid}-etims`}
            value={draft.etimsCode}
            onChange={(e) => set('etimsCode', e.target.value)}
            className={`${fieldClass} font-mono uppercase`}
            maxLength={5}
            autoComplete="off"
          />
        </Field>
        <div className="sm:col-span-2">
          <Field id={`${uid}-desc`} label="Description (optional)">
            <input
              id={`${uid}-desc`}
              value={draft.description}
              onChange={(e) => set('description', e.target.value)}
              className={fieldClass}
              maxLength={200}
              autoComplete="off"
            />
          </Field>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={primaryClass}>
          {submitWords(busy, unit?.id ?? null, 'Create unit')}
        </button>
        {onCancel === undefined ? null : (
          <button type="button" className={buttonClass} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/** The code of a chosen base unit: from what the server said about it, else the start of its words. */
function baseCode(base: Choice): string {
  return base.meta?.code ?? base.label.split(' · ')[0] ?? base.label;
}

function kindOf(kind: string): (typeof UNIT_KINDS)[number]['id'] {
  return UNIT_KINDS.find((k) => k.id === kind)?.id ?? 'count';
}
