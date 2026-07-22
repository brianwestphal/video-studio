import { UiRoot } from "./foundation.js";

// Foundation bundle only. VS-120 will mount the real review application here.
export function ReviewRoot() {
  return <UiRoot surface="review" />;
}
