'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  deleteUnitAction,
  makeDefaultUnitAction,
  setUnitActiveAction,
  unitsPageAction,
  type UnitView,
} from '@/server/domains/units/actions';
import { UnitForm } from '@/components/admin/settings/UnitForm';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { usePagedList } from '@/components/ui/usePagedList';
import {
  attempt,
  buttonClass,
  cardClass,
  Chip,
  fieldClass,
  LoadFailed,
  Message,
  PageHeader,
  primaryClass,
  type Notice,
} from '@/components/ui/screen-kit';
import { has } from '@/lib/values';
import type { Choice } from '@/lib/payment-options';

type FirstPage = Awaited<ReturnType<typeof unitsPageAction>>;

export function AdminUnitsClient({
  firstPage,
  canManage,
}: {
  firstPage: ReturnType<typeof unitsPageAction>;
  canManage: Promise<boolean>;
}) {
  const first = use(firstPage);
  const may = use(canManage);
  return first.ok ? <UnitsView first={first} may={may} /> : <LoadFailed error={first.error} />;
}

/** "1 G = 0.001 KG" for a unit that is a multiple of another; the family for a base unit. */
function meaning(row: UnitView): string {
  if (row.baseUnitCode !== null) return `1 ${row.code} = ${row.factorToBase} ${row.baseUnitCode}`;
  return row.kind === 'packaging'
    ? 'Holds a different amount for each product'
    : `Base unit of ${row.kindLabel.toLowerCase()}`;
}

function UnitsView({ first, may }: { first: FirstPage; may: boolean }) {
  const uid = useId();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<Choice | null>(null);
  const [onlyOn, setOnlyOn] = useState(false);
  const [editing, setEditing] = useState<UnitView | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const list = usePagedList<UnitView, { query: string; kind: string; onlyOn: boolean }>({
    load: (filters, cursor) =>
      unitsPageAction({
        query: filters.query,
        cursor,
        ...(filters.kind === '' ? {} : { kind: filters.kind }),
        ...(filters.onlyOn ? { status: 'active' as const } : {}),
      }),
    filters: { query: query.trim(), kind: kind?.id ?? '', onlyOn },
    initialPage: first,
  });

  const done = (ok: boolean, text: string) => {
    setBusy(false);
    setNotice({ kind: ok ? 'ok' : 'error', text });
    if (ok) {
      list.reload();
      router.refresh();
    }
  };
  const run = async (call: Promise<{ ok: boolean; error?: string }>, success: string) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(call);
    done(res.ok, res.ok ? success : (res.error ?? 'Something went wrong. Please try again.'));
  };

  const filtered = query.trim() !== '' || kind !== null || onlyOn;
  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title="Units of measure"
        intro="One list of units for the whole system. Units of one kind convert into each other (1 kg = 1000 g); packaging units such as a crate hold a different amount for each product. A unit that products use cannot be deleted: switch it off instead."
        actions={
          may && editing === null ? (
            <button
              type="button"
              className={primaryClass}
              onClick={() => {
                setNotice(null);
                setEditing('new');
              }}
            >
              New unit
            </button>
          ) : null
        }
      />
      <Message notice={notice} />

      {may && editing !== null ? (
        <section
          className={`${cardClass} space-y-3`}
          aria-label={editing === 'new' ? 'New unit of measure' : `Edit ${editing.code}`}
        >
          <h3 className="text-sm font-bold text-fg-strong">
            {editing === 'new' ? 'New unit of measure' : `Edit ${editing.code}`}
          </h3>
          <UnitForm
            key={editing === 'new' ? 'new' : editing.id}
            unit={editing === 'new' ? null : editing}
            autoFocus
            onCancel={() => setEditing(null)}
            onSaved={(saved) => {
              setEditing(null);
              done(true, `${saved.code} ${editing === 'new' ? 'created' : 'saved'}.`);
            }}
          />
        </section>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,20rem)_minmax(0,14rem)_auto] sm:items-end">
        <div>
          <label htmlFor={`${uid}-search`} className="sr-only">
            Search units
          </label>
          <input
            id={`${uid}-search`}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by code, name or symbol"
            className={fieldClass}
            autoComplete="off"
          />
        </div>
        <ChoicePicker
          label="Kind"
          source="unit-kinds"
          choice={kind}
          onChoice={setKind}
          placeholder="All kinds"
        />
        <label className="flex min-h-10 items-center gap-2 text-sm text-fg">
          <input type="checkbox" checked={onlyOn} onChange={(e) => setOnlyOn(e.target.checked)} />
          Only units that are on
        </label>
      </div>

      {list.phase === 'error' ? (
        <p role="alert" className="text-sm text-red-700">
          {list.error}{' '}
          <button type="button" className={buttonClass} onClick={list.retry}>
            Try again
          </button>
        </p>
      ) : null}
      {list.phase === 'loading' ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading…
        </p>
      ) : null}

      <ul className="space-y-2" aria-label="Units of measure">
        {list.rows.map((row) => (
          <li key={row.id} className="rounded-xl border border-line bg-surface-raised p-3 sm:p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-bold break-words text-fg-strong">
                  <span className="font-mono">{row.code}</span> · {row.name}
                  {has(row.symbol) ? (
                    <span className="font-normal text-fg-muted"> ({row.symbol})</span>
                  ) : null}
                </p>
                <p className="mt-1 text-xs break-words text-fg-muted">{meaning(row)}</p>
                <p className="mt-1.5 flex flex-wrap gap-1.5">
                  <Chip tone="gray">{row.kindLabel}</Chip>
                  <Chip tone="gray">
                    {row.decimals} {row.decimals === 1 ? 'decimal' : 'decimals'}
                  </Chip>
                  {row.isDefault ? <Chip tone="sky">Default</Chip> : null}
                  {row.isActive ? null : <Chip tone="amber">Switched off</Chip>}
                  {has(row.internationalCode) ? (
                    <Chip tone="gray">UN {row.internationalCode}</Chip>
                  ) : null}
                  {has(row.etimsCode) ? <Chip tone="gray">eTIMS {row.etimsCode}</Chip> : null}
                </p>
                <p className="mt-1.5 text-xs text-fg-muted">{row.usageWords ?? 'Not used yet'}</p>
              </div>
              {may ? (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() => {
                      setNotice(null);
                      setEditing(row);
                    }}
                    disabled={busy}
                    aria-label={`Edit ${row.code}`}
                  >
                    Edit
                  </button>
                  {row.isDefault ? null : (
                    <button
                      type="button"
                      className={buttonClass}
                      disabled={busy || !row.isActive}
                      onClick={() =>
                        void run(
                          makeDefaultUnitAction(row.id),
                          `${row.code} is now the default unit.`,
                        )
                      }
                      aria-label={`Make ${row.code} the default`}
                    >
                      Make default
                    </button>
                  )}
                  {row.isDefault ? null : (
                    <button
                      type="button"
                      className={buttonClass}
                      disabled={busy}
                      onClick={() =>
                        void run(
                          setUnitActiveAction(row.id, row.version, !row.isActive),
                          row.isActive
                            ? `${row.code} is switched off.`
                            : `${row.code} is switched on.`,
                        )
                      }
                      aria-label={`${row.isActive ? 'Switch off' : 'Switch on'} ${row.code}`}
                    >
                      {row.isActive ? 'Switch off' : 'Switch on'}
                    </button>
                  )}
                  {row.canDelete ? (
                    <InlineConfirm
                      label={`Delete unit ${row.code}`}
                      action="Delete"
                      confirm="Delete"
                      busy={busy}
                      onConfirm={() => void run(deleteUnitAction(row.id), `${row.code} deleted.`)}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {list.phase === 'idle' && list.rows.length === 0 ? (
        <p className="text-sm text-fg-muted">{filtered ? 'No units match.' : 'No units yet.'}</p>
      ) : null}
      {list.cursor === null ? null : (
        <button
          type="button"
          className={buttonClass}
          onClick={list.loadMore}
          disabled={list.phase === 'more'}
        >
          {list.phase === 'more' ? 'Loading…' : 'Show more units'}
        </button>
      )}
      <p className="text-xs text-fg-muted">
        <Link href="/admin/products" className="underline">
          Back to products
        </Link>
      </p>
    </div>
  );
}
