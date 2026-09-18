/** Only ordinary web links may leave the sandbox for the OS browser. */
export function safeExternalUrl(value: string): boolean {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}
