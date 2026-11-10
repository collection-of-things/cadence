/**
 * The message to show for a failed IPC call. Handler rejections arrive
 * wrapped; this keeps the adapter's own message. `fallback` covers a
 * rejection that is not an Error.
 */
export function cleanIpcError(e: unknown, fallback?: string): string {
  const msg = e instanceof Error ? e.message : (fallback ?? String(e));
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
