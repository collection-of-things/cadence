// providers.mjs — route health the honest way: read each route's own
// capability record. `local` must be ready. Streaming routes report readiness
// or a skip here; authenticated playback is a separate explicit flow.
import * as api from "../lib/api.mjs";
import { shot, navTo } from "../lib/flow.mjs";

export const name = "providers";

export async function run(ctx) {
  const { page, ev } = ctx;
  await navTo(ctx, "Sources", ".src");
  const caps = await api.capabilities(page);
  ev.dumpState("capabilities", caps);
  await shot(ctx, "sources-capabilities");

  const local = caps.find((c) => c.route === "local");
  ev.check("local route ready", local?.state === "ready",
    `${local?.state}${local?.stateDetail ? ` — ${local.stateDetail}` : ""}`);

  for (const cap of caps.filter((c) => c.route !== "local")) {
    if (cap.state === "ready") {
      // Readiness alone does not establish playback, even for Apple Music.
      ev.step("provider", `${cap.route} ready — readiness only; run a provider playback flow explicitly`);
      ev.check(`${cap.route} reported ready`, true, cap.playback.engine);
    } else {
      ev.step("provider", `${cap.route} skipped: ${cap.state}${cap.stateDetail ? ` (${cap.stateDetail})` : ""}`);
      ev.check(`${cap.route} cleanly skipped`, ["unauthenticated", "unavailable", "degraded"].includes(cap.state),
        cap.state, { required: false });
    }
  }
}
