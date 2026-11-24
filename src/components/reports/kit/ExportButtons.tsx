import { Download } from 'lucide-react';

const WORDS = { csv: 'CSV', xlsx: 'Excel', pdf: 'PDF' } as const;

/**
 * Download links for a report, one per format it offers. They are plain links to the export address, so they work without
 * script, can be opened in a new tab, and the server makes the file on the spot (and records the download). A cut list
 * cannot be downloaded: the links are replaced by a sentence saying why.
 */
export function ExportButtons({
  code,
  formats,
  query,
  truncated,
}: {
  code: string;
  formats: readonly ('csv' | 'xlsx' | 'pdf')[];
  /** The report's own parameters as a query string, so the file matches what is on the screen. */
  query: string;
  truncated: boolean;
}) {
  if (truncated) {
    return <p className="text-xs text-fg-muted">Narrow the report to download it.</p>;
  }
  return (
    <div role="group" aria-label="Download" className="flex flex-wrap gap-2">
      {formats.map((format) => {
        const params = new URLSearchParams(query);
        params.set('format', format);
        return (
          <a
            key={format}
            href={`/api/admin/reports/${code}/export?${params.toString()}`}
            download
            data-testid={`download-${format}`}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-line-strong bg-surface-sunken px-3 text-xs font-semibold text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500"
          >
            <Download className="size-3.5" aria-hidden />
            {WORDS[format]}
          </a>
        );
      })}
    </div>
  );
}
