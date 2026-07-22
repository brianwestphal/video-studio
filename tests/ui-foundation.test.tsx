import { describe, expect, it } from "vitest";

import { UiRoot } from "../ui/foundation.js";

describe("kerf UI foundation", () => {
  it("renders stable surface roots and escapes dynamic children", () => {
    expect(UiRoot({ surface: "desktop", children: "<unsafe>" }).toString()).toBe(
      '<div id="desktop-kerf-root" data-key="desktop-root" data-ui-runtime="kerfjs">&lt;unsafe&gt;</div>',
    );
    expect(UiRoot({ surface: "review" }).toString()).toBe(
      '<div id="review-kerf-root" data-key="review-root" data-ui-runtime="kerfjs"></div>',
    );
  });
});
