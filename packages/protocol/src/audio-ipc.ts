/**
 * Control protocol between the Electron coordinator and the Rust audio
 * service (`cadence-audio`). Newline-delimited JSON-RPC 2.0 over stdio.
 *
 * - Requests:   {"jsonrpc":"2.0","id":N,"method":"...","params":{...}}
 * - Responses:  {"jsonrpc":"2.0","id":N,"result":{...}} or {"error":{...}}
 * - Events:     {"jsonrpc":"2.0","method":"event.<name>","params":{...}}
 *
 * The service is supervised: the coordinator may restart it and replay
 * queue intent without starting playback unexpectedly.
 */

export type AudioRpcRequest =
  | { method: "audio.ping"; params: {} }
  /** Load a queue item's media. Local: absolute path. Streaming PCM: pushed via audio.feed. */
  | {
      method: "audio.load";
      params: {
        queueId: string;
        generationId: number;
        source:
          | { kind: "file"; path: string }
          /** Streaming PCM source (e.g. librespot pipe sink). Either the service
           *  reads `fifoPath` itself, or chunks are pushed via audio.feed. */
          | {
              kind: "pcm-stream";
              sampleRateHz: number;
              channels: number;
              bitDepth: number | "float";
              fifoPath?: string;
            };
        /** Start paused at this position instead of playing. */
        startPaused?: boolean;
        positionMs?: number;
        replayGainDb?: number;
      };
    }
  /** Prefetch a successor under the current lease generation — stale
   *  generations are rejected so a skip can never install the wrong track. */
  | {
      method: "audio.prefetch";
      params: { queueId: string; path: string; generationId: number; replayGainDb?: number };
    }
  /** Drop an installed prefetch — queue edits must cancel the successor
   *  the engine would otherwise promote at the boundary. */
  | { method: "audio.clearPrefetch"; params: { generationId: number } }
  /** Push a PCM chunk into the pcm-stream source opened under `queueId`
   *  (base64 little-endian interleaved frames in the declared depth).
   *  `final` marks end-of-stream (remaining buffered audio plays out);
   *  `abort` discards the stream immediately. dataBase64 is omitted on
   *  control-only frames (final/abort). */
  | {
      method: "audio.feed";
      params: { queueId: string; dataBase64?: string; final?: boolean; abort?: boolean };
    }
  | { method: "audio.play"; params: { generationId: number } }
  | { method: "audio.pause"; params: { generationId: number } }
  | { method: "audio.stop"; params: { generationId: number } }
  | { method: "audio.seek"; params: { generationId: number; positionMs: number } }
  | { method: "audio.setVolume"; params: { volume: number } }
  /** Strict local fidelity: bypass EQ/resample/DSP when the device accepts the source format. */
  | { method: "audio.setFidelityMode"; params: { enabled: boolean } }
  /** ReplayGain user toggle: tag gains apply only when enabled (off by default). */
  | { method: "audio.setReplayGain"; params: { enabled: boolean } }
  | { method: "audio.setEq"; params: { bands: { freqHz: number; gainDb: number }[] } }
  | { method: "audio.listDevices"; params: {} }
  | { method: "audio.setDevice"; params: { name: string | null } } // null = default
  | { method: "audio.shutdown"; params: {} };

export type AudioRpcEvent =
  | {
      method: "event.state";
      params: { generationId: number; state: "idle" | "loading" | "playing" | "paused" | "stopped" | "error"; detail?: string };
    }
  | { method: "event.position"; params: { generationId: number; positionMs: number; durationMs: number; atMs: number } }
  | {
      method: "event.trackEnded";
      params: { generationId: number; queueId: string; /** true when the next prefetched track started seamlessly */ gapless: boolean };
    }
  | { method: "event.trackStarted"; params: { generationId: number; queueId: string; durationMs: number; gapless: boolean } }
  /** Compact FFT bands (~0.5 log-spaced bins), emitted ~20-30Hz while playing. */
  | { method: "event.fft"; params: { generationId: number; bands: number[]; peak: number; atMs: number } }
  | {
      method: "event.output";
      params: {
        deviceName: string;
        sampleRateHz: number;
        channels: number;
        bitDepth: number | "float";
        exclusive: boolean;
        fidelityBypass: boolean;
      };
    }
  | { method: "event.buffering"; params: { generationId: number; queueId: string } }
  | { method: "event.prefetchReady"; params: { generationId: number; queueId: string } }
  | { method: "event.error"; params: { generationId: number; queueId?: string; message: string; retriable: boolean } };

export type AnyAudioMessage =
  | ({ jsonrpc: "2.0"; id: number } & AudioRpcRequest)
  | { jsonrpc: "2.0"; id: number; result: unknown }
  | { jsonrpc: "2.0"; id: number; error: { code: number; message: string } }
  | ({ jsonrpc: "2.0" } & AudioRpcEvent);

/** Band count the service emits in event.fft (log-spaced 20Hz..20kHz). */
export const FFT_BANDS = 48;
