/**
 * Port for pushing decoded provider PCM (e.g. a librespot session) into the
 * shared audio graph. Implemented by the AudioServiceClient; consumed by
 * provider adapters such as SpotifyLibrespotAdapter.
 */

/** Stream format negotiated with the audio graph. */
export interface PcmFormat {
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly bitDepth: number | "float";
}

/** One open push-channel for PCM chunks into the audio graph. */
export interface PcmStream {
  /** The stream identifier (the queueId this stream was opened under). */
  readonly streamId: string;
  /**
   * Push one interleaved PCM chunk. Resolves when the chunk is accepted —
   * awaiting it provides backpressure (fifo buffer / feed acknowledgement).
   */
  write(chunk: Uint8Array): Promise<void>;
  /** Signal end-of-stream; the engine plays out what remains buffered. */
  end(): Promise<void>;
  /** Abort the stream and release resources immediately. */
  abort(): Promise<void>;
}

/** Opens pcm-stream sources on the audio service. */
export interface PcmStreamSink {
  /** Open a PCM stream bound to a queueId + lease generation. */
  openStream(input: { queueId: string; generationId: number } & PcmFormat): Promise<PcmStream>;
}
