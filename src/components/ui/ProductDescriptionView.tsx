'use client';

import { parseProductDescription } from '@/lib/productDescription';

interface ProductDescriptionViewProps {
  description: string;
  className?: string;
  /** Compact single-block style for tight layouts */
  dense?: boolean;
}

/** Renders a stored product description with subheadings + body sections. */
export function ProductDescriptionView({
  description,
  className = '',
  dense = false,
}: ProductDescriptionViewProps) {
  const sections = parseProductDescription(description).filter(
    (s) => s.heading.trim() || s.body.trim(),
  );

  if (sections.length === 0) {
    return <p className={`text-xs text-zinc-500 ${className}`}>No description provided.</p>;
  }

  return (
    <div className={`space-y-3 ${className}`}>
      {sections.map((section) => {
        const heading = section.heading.trim();
        const body = section.body.trim();
        return (
          <div key={section.id} className={dense ? 'space-y-1' : 'space-y-1.5'}>
            {heading ? (
              <h4
                className={`font-semibold text-white ${dense ? 'text-[11px]' : 'text-xs'}`}
              >
                {heading}
              </h4>
            ) : null}
            {body ? (
              <p
                className={`whitespace-pre-wrap leading-relaxed text-zinc-300 ${
                  dense ? 'text-[11px]' : 'text-xs'
                }`}
              >
                {body}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
