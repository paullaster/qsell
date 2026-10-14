'use client';

import type { Choice } from '@/lib/payment-options';
import { LookupAutocomplete, type LookupAutocompleteProps } from './LookupAutocomplete';

export interface ChoicePickerProps extends Omit<LookupAutocompleteProps, 'value' | 'valueLabel' | 'onChange'> {
  /** The chosen option (its id and the words to show for it), or null. */
  choice: Choice | null;
  onChoice: (choice: Choice | null) => void;
}

/** A LookupAutocomplete whose value is one `{ id, label }`, so a saved value shows its words before the list is ever opened. */
export function ChoicePicker({ choice, onChoice, ...props }: ChoicePickerProps) {
  return (
    <LookupAutocomplete
      {...props}
      value={choice?.id ?? null}
      valueLabel={choice?.label ?? null}
      onChange={(option) => onChoice(option ? { id: option.id, label: option.label } : null)}
    />
  );
}
