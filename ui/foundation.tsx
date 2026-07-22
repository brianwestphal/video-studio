import type { SafeHtml } from "./kerf.js";

export type UiSurface = "desktop" | "review";

// Shared root marker used by both migration entry points. String children are escaped by
// kerf; the stable id/data-key also gives browser automation a common readiness target.
export function UiRoot({ surface, children }: { surface: UiSurface; children?: SafeHtml | string }): SafeHtml {
  return <div id={`${surface}-kerf-root`} data-key={`${surface}-root`} data-ui-runtime="kerfjs">{children}</div>;
}
