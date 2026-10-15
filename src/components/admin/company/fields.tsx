'use client';

import { useId, type HTMLInputTypeAttribute } from 'react';
import { Field, fieldClass } from '@/components/ui/screen-kit';

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  placeholder?: string;
  type?: HTMLInputTypeAttribute;
  inputMode?: 'text' | 'tel' | 'email' | 'url' | 'numeric';
  maxLength?: number;
  required?: boolean;
  wide?: boolean;
  mono?: boolean;
  autoComplete?: string;
}

/** A labelled text box: the label is tied to the box, so it is read out and clicking it focuses the box. */
export function TextField({ label, value, onChange, hint, placeholder, type = 'text', inputMode, maxLength, required, wide, mono, autoComplete = 'off' }: TextFieldProps) {
  const id = useId();
  return (
    <div className={wide === true ? 'md:col-span-2' : undefined}>
      <Field id={id} label={label} hint={hint}>
        <input
          id={id}
          type={type}
          inputMode={inputMode}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          required={required}
          autoComplete={autoComplete}
          className={mono === true ? `${fieldClass} font-mono` : fieldClass}
        />
      </Field>
    </div>
  );
}

/** A card that groups related fields under a heading. */
export function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-4 rounded-xl border border-line bg-surface-sunken/60 p-4 sm:p-5">
      <h3 id={id} className="flex items-center gap-2 text-sm font-bold text-fg-strong">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}
