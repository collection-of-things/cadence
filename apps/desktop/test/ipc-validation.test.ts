import { describe, expect, it } from "vitest";
import { parsePlaybackCommand } from "../src/ipc-validation.js";

// Every PlaybackCommand kind the UI can send must parse here — a missing
// case silently swallows the command (the ReplayGain toggle regressed
// this way once).
describe("parsePlaybackCommand", () => {
  it("accepts setReplayGain with a boolean", () => {
    const r = parsePlaybackCommand({ kind: "setReplayGain", enabled: true });
    expect(r._tag).toBe("ok");
    if (r._tag === "ok") {
      expect(r.value).toEqual({ kind: "setReplayGain", enabled: true });
    }
  });

  it("rejects setReplayGain with a non-boolean", () => {
    const r = parsePlaybackCommand({ kind: "setReplayGain", enabled: "yes" });
    expect(r._tag).toBe("err");
  });

  it("accepts setFidelityMode with a boolean", () => {
    const r = parsePlaybackCommand({ kind: "setFidelityMode", enabled: false });
    expect(r._tag).toBe("ok");
  });
});
