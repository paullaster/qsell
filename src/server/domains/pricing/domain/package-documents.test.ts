import { describe, expect, it } from 'vitest';
import { isPackageDocumentType, PACKAGE_DOCUMENT_TYPES } from './package-documents';

describe('the documents that can sell a package', () => {
  it('lists each type once, with a name a person can read', () => {
    const types = PACKAGE_DOCUMENT_TYPES.map((t) => t.type);
    expect(new Set(types).size).toBe(types.length);
    expect(PACKAGE_DOCUMENT_TYPES.every((t) => t.label.length > 3)).toBe(true);
  });
  it('recognises a registered type and nothing else', () => {
    expect(isPackageDocumentType('order')).toBe(true);
    expect(isPackageDocumentType('quote')).toBe(true);
    expect(isPackageDocumentType('pos_sale')).toBe(false);
    expect(isPackageDocumentType('')).toBe(false);
  });
});
