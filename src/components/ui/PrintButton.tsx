'use client';

import { useState } from 'react';
import { printElement } from '@/lib/print/print-element';
import type { Paper } from '@/lib/print/print-document';
import { buttonClass } from './screen-kit';

/** Prints one part of the screen (the element with this id) on its own, on A4 or as a till slip: never the page around it. */
export function PrintButton({ targetId, title, paper = 'a4', label = 'Print', className = buttonClass, testId }: { targetId: string; title: string; paper?: Paper; label?: string; className?: string; testId?: string }) {
  const [problem, setProblem] = useState(false);
  return (
    <>
      <button type="button" className={className} data-testid={testId} onClick={() => void printElement(targetId, { title, paper }).then((found) => setProblem(!found))}>{label}</button>
      {problem ? <span role="alert" className="text-sm text-red-700">Nothing to print here yet.</span> : null}
    </>
  );
}
