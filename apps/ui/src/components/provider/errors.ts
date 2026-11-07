/** IPC handler rejections arrive wrapped; keep the adapter's own message. */
export function cleanIpcError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
