/**
 * The documents that can sell a configurable package (docs/architecture/configurable-packages.md section 10.7). A document type is
 * added here when it is built; a shared test then runs the same package cases against every type listed, so a new place of sale is
 * not finished until it sells a package the way the others do. The point of sale, sales orders, sales invoices and credit sales
 * register themselves here when they are built.
 */
export const PACKAGE_DOCUMENT_TYPES = [
  { type: 'order', label: 'Web shop and staff orders' },
  { type: 'quote', label: 'Quotes' },
] as const;

export type PackageDocumentType = (typeof PACKAGE_DOCUMENT_TYPES)[number]['type'];

export const isPackageDocumentType = (value: string): value is PackageDocumentType => PACKAGE_DOCUMENT_TYPES.some((t) => t.type === value);
