'use client';

import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { INVENTORY_KIND_OPTIONS, isInventoryKind, type InventoryKind } from '@/lib/inventory-kind';

/** The label a stored kind is shown with. */
export const inventoryKindLabel = (kind: InventoryKind): string => INVENTORY_KIND_OPTIONS.find((option) => option.id === kind)?.label ?? 'Inventory item';

/**
 * What products of a business classification are: stocked goods, goods that are not stocked, or services. New products take this
 * as their starting stock behaviour; products that already exist keep theirs.
 */
export function BehavesAsField({ value, onChange }: { value: InventoryKind; onChange: (kind: InventoryKind) => void }) {
  const option = INVENTORY_KIND_OPTIONS.find((candidate) => candidate.id === value);
  return (
    <div className="space-y-2">
      <ChoicePicker
        label="Products of this classification behave as"
        source="inventory-kinds"
        choice={{ id: value, label: inventoryKindLabel(value) }}
        onChoice={(choice) => {
          if (choice !== null && isInventoryKind(choice.id)) onChange(choice.id);
        }}
        placeholder="Choose how they are managed"
        clearable={false}
        required
      />
      <p className="text-[11px] leading-relaxed text-fg-subtle">
        {option?.description ?? ''} New products start with this; a product can still be changed until it has stock or documents. Products that already exist keep what they have.
      </p>
      {value === 'service' ? (
        <p className="rounded-lg border border-line bg-surface-raised p-2 text-[11px] leading-relaxed text-fg-muted">
          A service needs no cost of goods, holds no stock, and needs no selling price. One without a price is not sold from the shop, which suits things like delivery; give it a price to sell it.
        </p>
      ) : null}
    </div>
  );
}
