'use client';

import { useState, type ComponentProps } from 'react';
import { Eye, EyeOff } from 'lucide-react';

type PasswordInputProps = Omit<ComponentProps<'input'>, 'type' | 'id'> & {
  id: string;
};

/**
 * Password field with a show/hide toggle so people can check what they typed.
 * The toggle is a real button (keyboard and screen-reader operable) and never
 * submits the form.
 */
export function PasswordInput({ id, className, ...inputProps }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOff : Eye;

  return (
    <div className="relative">
      <input
        {...inputProps}
        id={id}
        type={visible ? 'text' : 'password'}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className={`w-full rounded-lg border border-line bg-surface py-2 pr-11 pl-3 text-sm text-fg-strong ${className ?? ''}`}
      />
      <button
        type="button"
        onClick={() => setVisible((current) => !current)}
        aria-controls={id}
        aria-pressed={visible}
        aria-label={visible ? 'Hide password' : 'Show password'}
        title={visible ? 'Hide password' : 'Show password'}
        className="absolute inset-y-0 right-0 flex w-11 touch-manipulation items-center justify-center rounded-r-lg text-fg-muted hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-indigo-500"
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
