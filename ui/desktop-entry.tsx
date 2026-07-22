import { UiRoot } from "./foundation.js";

// Foundation bundle only. VS-119 will mount the real desktop application here.
export function DesktopRoot() {
  return <UiRoot surface="desktop" />;
}
