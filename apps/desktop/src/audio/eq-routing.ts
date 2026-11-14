import type { RouteId } from "@cadence/protocol";

type Bands = readonly { freqHz: number; gainDb: number }[];
type EqRoute = { readonly route: RouteId; setEq(bands: Bands): Promise<void> };

/** Apply EQ to all engines and report failure from the active playback route. */
export async function applyEqToRoutes(
  bands: Bands,
  activeRoute: RouteId | null,
  engine: (bands: Bands) => Promise<unknown>,
  routes: readonly EqRoute[],
): Promise<void> {
  const activeIndex = routes.findIndex((route) => route.route === activeRoute);
  const results = await Promise.allSettled([engine(bands), ...routes.map((route) => route.setEq(bands))]);
  const result = results[activeIndex + 1];
  if (result?.status === "rejected") throw result.reason;
}
