
import { has } from '@/lib/has';
/**
 * Product descriptions are stored as a single string.
 * Structured sections use Markdown AT2 headings:
 *
 *   ## Package
 *
 *   Line one…
 *
 *   ## What you can power
 *
 *   More copy…
 *
 * Legacy plain text (no ## headings) is treated as one untitled body block.
 */

export interface ProductDescriptionSection {
  id: string;
  heading: string;
  body: string;
}

function newSectionId(): string {
  return `sec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createEmptyDescriptionSection(
  partial?: Partial<Pick<ProductDescriptionSection, 'heading' | 'body'>>,
): ProductDescriptionSection {
  return {
    id: newSectionId(),
    heading: partial?.heading ?? '',
    body: partial?.body ?? '',
  };
}

/** Parse a stored description into editable sections (fault-tolerant). */
export function parseProductDescription(raw: string | null | undefined): ProductDescriptionSection[] {
  const text = typeof raw === 'string' ? raw.replace(/\r\n/g, '\n').trim() : '';
  if (!has(text)) {
    return [createEmptyDescriptionSection()];
  }

  // Split on AT2 markers at line start. Keep content between them.
  const headingSplit = /(?:^|\n)##\s+([^\n]*)\n?/g;
  const matches = [...text.matchAll(headingSplit)];

  if (matches.length === 0) {
    return [createEmptyDescriptionSection({ body: text })];
  }

  const sections: ProductDescriptionSection[] = [];

  // Leading content before the first ## becomes an untitled intro block.
  const firstIndex = matches[0]!.index ?? 0;
  if (firstIndex > 0) {
    const intro = text.slice(0, firstIndex).trim();
    if (has(intro)) {
      sections.push(createEmptyDescriptionSection({ body: intro }));
    }
  }

  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]!;
    const heading = (match[1] ?? '').trim();
    const start = (match.index ?? 0) + match[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1]!.index ?? text.length) : text.length;
    const body = text.slice(start, end).trim();
    sections.push(createEmptyDescriptionSection({ heading, body }));
  }

  return sections.length > 0 ? sections : [createEmptyDescriptionSection()];
}

/** Serialize sections back to a single description string. */
export function serializeProductDescription(sections: ProductDescriptionSection[]): string {
  const parts: string[] = [];

  for (const section of sections) {
    const heading = section.heading.trim();
    const body = section.body.trim();
    if (!has(heading) && !has(body)) continue;

    if (has(heading)) {
      parts.push(has(body) ? `## ${heading}\n\n${body}` : `## ${heading}`);
    } else {
      parts.push(body);
    }
  }

  return parts.join('\n\n').trim();
}

/** Plain text for cards/search — headings become readable separators. */
export function productDescriptionPlainText(raw: string | null | undefined): string {
  return parseProductDescription(raw)
    .map((s) => {
      const heading = s.heading.trim();
      const body = s.body.trim();
      if (has(heading) && has(body)) return `${heading}: ${body}`;
      return heading || body;
    })
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
