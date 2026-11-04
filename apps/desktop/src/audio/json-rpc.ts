import type { AudioRpcEvent } from "@cadence/protocol";

/**
 * Newline-delimited JSON-RPC 2.0 framing for the cadence-audio stdio
 * protocol. Pure functions so the wire format is testable without a process.
 */

/** Serialize one outbound message (request or notification) to a wire line. */
export function encodeMessage(msg: Record<string, unknown>): string {
  return `${JSON.stringify(msg)}\n`;
}

/** One decoded inbound line from the audio service. */
export type InboundMessage =
  | { readonly kind: "result"; readonly id: number; readonly result: unknown }
  | { readonly kind: "error"; readonly id: number; readonly code: number; readonly message: string }
  | { readonly kind: "event"; readonly event: AudioRpcEvent }
  | { readonly kind: "malformed"; readonly raw: string };

/** Parse one newline-delimited line into a classified inbound message. */
export function parseLine(line: string): InboundMessage {
  const trimmed = line.trim();
  if (trimmed === "") return { kind: "malformed", raw: line };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "malformed", raw: trimmed };
  }
  if (typeof parsed !== "object" || parsed === null) return { kind: "malformed", raw: trimmed };
  const msg = parsed as Record<string, unknown>;

  if (typeof msg.id === "number") {
    if ("error" in msg && typeof msg.error === "object" && msg.error !== null) {
      const e = msg.error as Record<string, unknown>;
      return {
        kind: "error",
        id: msg.id,
        code: typeof e.code === "number" ? e.code : -32000,
        message: typeof e.message === "string" ? e.message : "unknown audio-service error",
      };
    }
    return { kind: "result", id: msg.id, result: msg.result };
  }
  if (typeof msg.method === "string" && msg.method.startsWith("event.") && typeof msg.params === "object") {
    // SAFETY: the envelope (method "event.*", object params) is checked; the
    // audio service is a trusted local peer. Field-level misuse degrades to
    // harmless no-ops downstream.
    return { kind: "event", event: { method: msg.method, params: msg.params } as AudioRpcEvent };
  }
  return { kind: "malformed", raw: trimmed };
}
