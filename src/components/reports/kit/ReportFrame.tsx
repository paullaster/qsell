import { BackButton } from './BackButton';

/**
 * The page around a report: its title, the downloads, and, for a report that is about things as they are right now, when it
 * was read. A report that has a period shows its dates, scope and update time in the filter bar, so they are not repeated here.
 */
export function ReportFrame({
  title,
  actions,
  note,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  /** One short line under the title, such as "Stock as at 23 Nov, 07:05". */
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-7xl space-y-5 p-3 sm:p-5">
      <BackButton />
      <header className="space-y-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="min-w-0 text-xl font-bold text-fg-strong sm:text-2xl">{title}</h2>
          {actions === undefined ? null : <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
        {note === undefined ? null : <p className="text-sm text-fg-muted">{note}</p>}
      </header>
      {children}
    </div>
  );
}
