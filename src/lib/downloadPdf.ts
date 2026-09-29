export function downloadPdfBase64(base64: string, filename: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  downloadBlob(new Blob([bytes], { type: 'application/pdf' }), filename);
}

/**
 * Save CSV text as a file. A Blob (unlike a `data:` URL) has no length limit and
 * needs no URI escaping, so characters such as `#` cannot truncate the file.
 */
export function downloadCsv(csv: string, filename: string) {
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), filename);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
