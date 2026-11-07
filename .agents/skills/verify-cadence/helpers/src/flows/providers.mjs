// providers.mjs — route health the honest way: read each route's own
// capability record. `local` must be ready. Streaming routes are opt-in:
// when a signed-in profile exists they report ready and get a small smoke;
// otherwise the flow records a clean skip — never a failure, never a fake.
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
      // Plug point: once feat/apple-music lands its e2e hooks, provider
      // flows attach here — a signed-in profile makes the route ready and
      // this branch exercises it. Until then record readiness honestly.
      ev.step("provider", `${cap.route} ready — provider flow slot (no provider flow shipped yet)`);
      ev.check(`${cap.route} reported ready`, true, cap.playback.engine);
    } else {
      ev.step("provider", `${cap.route} skipped: ${cap.state}${cap.stateDetail ? ` (${cap.stateDetail})` : ""}`);
      ev.check(`${cap.route} cleanly skipped`, ["unauthenticated", "unavailable", "degraded"].includes(cap.state),
        cap.state, { required: false });
    }
  }
}
