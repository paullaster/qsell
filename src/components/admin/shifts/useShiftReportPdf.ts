'use client';

import { useState } from 'react';
import { shiftReportPdfAction } from '@/server/domains/selling/shifts/shift-actions';

const blobOf = (base64: string): Blob => {
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  return new Blob([bytes], { type: 'application/pdf' });
};

/** A shift report as a PDF made on the server: saved as a file, or printed from a hidden frame, so what prints is the clean report and never the page around it. */
export function useShiftReportPdf(shiftId: string): { busy: boolean; problem: string | null; download: () => void; print: () => void } {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const make = async (then: (blob: Blob, filename: string) => void) => {
    setBusy(true);
    setProblem(null);
    try {
      const made = await shiftReportPdfAction(shiftId);
      if (made.ok) then(blobOf(made.data.base64), made.data.filename);
      else setProblem(made.error);
    } catch {
      setProblem('The report could not be made into a PDF just now. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const download = () =>
    void make((blob, filename) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    });

  const print = () =>
    void make((blob) => {
      const url = URL.createObjectURL(blob);
      const frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
      frame.onload = () => {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
        setTimeout(() => {
          frame.remove();
          URL.revokeObjectURL(url);
        }, 60_000);
      };
      frame.src = url;
      document.body.append(frame);
    });

  return { busy, problem, download, print };
}
