import { describe, expect, it } from "vitest";
import { applyEqToRoutes } from "../src/audio/eq-routing.js";

describe("EQ routing", () => {
  const bands = [{ freqHz: 60, gainDb: 2 }];
  it("reports the active Apple route failure even when the local engine succeeds", async () => {
    const apple = { route: "apple-musickit" as const, setEq: async () => { throw new Error("graph failed"); } };
    await expect(applyEqToRoutes(bands, "apple-musickit", async () => ({}), [apple])).rejects.toThrow("graph failed");
  });
  it("does not report an inactive engine failure as an Apple EQ failure", async () => {
    const apple = { route: "apple-musickit" as const, setEq: async () => {} };
    await expect(applyEqToRoutes(bands, "apple-musickit", async () => { throw new Error("engine down"); }, [apple])).resolves.toBeUndefined();
    await expect(applyEqToRoutes(bands, "local", async () => { throw new Error("engine down"); }, [apple])).rejects.toThrow("engine down");
  });
});
