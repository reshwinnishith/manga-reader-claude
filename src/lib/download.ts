/** Browser downloads never write to localStorage. */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Preserve every code unit returned by getItem, including malformed Unicode.
 * No JSON parsing, reformatting or newline normalization. A UTF-16LE BOM lets
 * editors detect the encoding; the bytes after the BOM are the original text.
 */
export function originalStorageBlob(raw: string): Blob {
  const bytes = new Uint8Array(2 + raw.length * 2);
  bytes[0] = 0xff; bytes[1] = 0xfe;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    bytes[2 + i * 2] = code & 0xff;
    bytes[3 + i * 2] = code >>> 8;
  }
  return new Blob([bytes], { type: "text/plain;charset=utf-16le" });
}
