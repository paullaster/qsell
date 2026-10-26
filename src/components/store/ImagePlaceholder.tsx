import { ImageOff } from 'lucide-react';

/** Stands in for a product with no picture, so the card keeps its shape and says why it is empty. */
export function ImagePlaceholder() {
  return (
    <div role="img" aria-label="No picture available" className="flex h-full w-full items-center justify-center bg-surface-sunken text-fg-faint">
      <ImageOff className="h-10 w-10" aria-hidden="true" />
    </div>
  );
}
