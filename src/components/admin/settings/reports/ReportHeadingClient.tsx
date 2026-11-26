'use client';

import { use, useState } from 'react';
import { BrandingChoices, type BrandingPreset } from '@/components/admin/settings/BrandingChoices';
import { LoadFailed, Message, PageHeader, attempt, cardClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { PLAIN_HEADING, STANDARD_LETTERHEAD, type BrandShow } from '@/lib/print-branding';
import {
  saveReportPrintAction,
  type ReportPrintScreen,
  type reportPrintScreenAction,
} from '@/server/domains/company/print-branding-actions';

type Loaded = Awaited<ReturnType<typeof reportPrintScreenAction>>;

const PRESETS: readonly BrandingPreset[] = [
  { label: 'Standard letterhead', show: STANDARD_LETTERHEAD },
  { label: 'Business name only', show: PLAIN_HEADING },
];

const same = (a: BrandShow, b: BrandShow): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The heading of downloaded reports: for all of them (`moduleCode` null), or for the reports of one module. */
export function ReportHeadingClient({
  firstPromise,
  moduleCode,
}: {
  firstPromise: ReturnType<typeof reportPrintScreenAction>;
  moduleCode: string | null;
}) {
  const res: Loaded = use(firstPromise);
  if (!res.ok) return <LoadFailed error={res.error} />;
  return <Body initial={res.data} moduleCode={moduleCode} />;
}

function Body({ initial, moduleCode }: { initial: ReportPrintScreen; moduleCode: string | null }) {
  const moduleInfo = initial.modules.find((m) => m.code === moduleCode) ?? null;
  const [screen, setScreen] = useState(initial);
  const savedModule = screen.modules.find((m) => m.code === moduleCode) ?? null;
  const savedShow = savedModule === null ? screen.general : (savedModule.own ?? screen.general);
  const savedOwn = savedModule === null ? true : savedModule.own !== null;

  const [own, setOwn] = useState(savedOwn);
  const [show, setShow] = useState<BrandShow>(savedShow);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const changed = own !== savedOwn || (own && !same(show, savedShow));

  const save = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(saveReportPrintAction({ module: moduleCode, show: own ? show : null }));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setScreen(res.data);
    const next = res.data.modules.find((m) => m.code === moduleCode);
    setOwn(next === undefined ? true : next.own !== null);
    setShow(next === undefined ? res.data.general : (next.own ?? res.data.general));
    setNotice({ kind: 'ok', text: 'Saved. The next report you download uses this heading.' });
  };

  const title = moduleInfo === null ? 'All reports' : `${moduleInfo.label} reports`;
  const plainAlready = same(show, PLAIN_HEADING);

  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader
        title={title}
        intro={
          moduleInfo === null
            ? 'What the top of every downloaded report shows above its name. A module can have its own heading.'
            : 'What the top of a downloaded report from this module shows above its name.'
        }
      />
      <Message notice={notice} />
      <section className={`${cardClass} space-y-4`}>
        {moduleInfo === null ? null : (
          <label className="flex min-h-10 cursor-pointer items-center gap-2.5 text-sm font-semibold text-fg-strong">
            <input
              type="checkbox"
              className="size-4 accent-indigo-600"
              checked={!own}
              onChange={(event) => {
                setOwn(!event.target.checked);
                if (event.target.checked) setShow(screen.general);
              }}
            />
            Use the heading of all reports
          </label>
        )}
        {own ? (
          <BrandingChoices
            profile={screen.profile}
            value={show}
            onChange={setShow}
            presets={PRESETS}
            kind="report"
            name="report-heading"
          />
        ) : (
          <p className="text-sm text-fg-muted">
            This module follows the heading set under All reports. Untick the box to give it its own.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={primaryClass} disabled={busy || !changed} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          {own && plainAlready ? (
            <span className="text-xs text-fg-muted">Reports show the business name only.</span>
          ) : null}
        </div>
      </section>
    </div>
  );
}
