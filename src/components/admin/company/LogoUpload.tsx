'use client';

import { useId, useRef, useState } from 'react';
import { uploadCompanyLogoAction } from '@/server/domains/company/actions';
import { attempt } from '@/components/ui/screen-kit';
import { MAX_LOGO_BYTES } from '@/lib/logo-file';

/** Sends a new logo to the server; the server decides what the file really is. */
export function LogoUpload({ onUploaded }: { onUploaded: (logoUrl: string) => void }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const choose = async (file: File | null) => {
    if (file === null) return;
    if (file.size > MAX_LOGO_BYTES) {
      setMessage({ kind: 'error', text: 'The logo must be 2 MB or smaller.' });
      return;
    }
    setBusy(true);
    setMessage(null);
    const data = new FormData();
    data.set('logo', file);
    const res = await attempt(uploadCompanyLogoAction(data));
    setBusy(false);
    if (input.current !== null) input.current.value = '';
    if (!res.ok) {
      setMessage({ kind: 'error', text: res.error });
      return;
    }
    onUploaded(res.data.logoUrl);
    setMessage({ kind: 'ok', text: 'Logo uploaded. The navbar, admin, invoices and emails will use it.' });
  };

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-semibold text-fg">
        Company logo
      </label>
      <input
        id={id}
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        disabled={busy}
        onChange={(e) => void choose(e.target.files?.[0] ?? null)}
        className="block min-h-10 w-full text-sm text-fg-muted file:mr-3 file:min-h-10 file:cursor-pointer file:rounded-lg file:border-0 file:bg-indigo-600 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-indigo-500"
      />
      <p className="mt-1 text-[11px] text-fg-muted">PNG, JPEG, WebP or plain SVG up to 2 MB.</p>
      <div aria-live="polite">
        {busy ? <p role="status" className="mt-1 text-xs text-indigo-600">Uploading logo…</p> : null}
        {message === null ? null : (
          <p role={message.kind === 'error' ? 'alert' : 'status'} className={`mt-1 text-xs ${message.kind === 'error' ? 'text-red-700' : 'text-emerald-700'}`}>
            {message.text}
          </p>
        )}
      </div>
    </div>
  );
}
