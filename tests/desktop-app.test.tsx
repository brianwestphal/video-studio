import { describe, expect, it } from "vitest";

import { buildAutoPrompt, cutKindFromPrompt, DesktopApp, displayState } from "../ui/desktop-app.js";

describe("desktop Kerf app", () => {
  it("derives rail display state without losing locked/done semantics", () => {
    expect(displayState({ key: "analyze", label: "Analyze", state: "locked" }, "analyze")).toBe("locked");
    expect(displayState({ key: "design", label: "Design", state: "done" }, "setup")).toBe("done");
    expect(displayState({ key: "export", label: "Export", state: "idle" }, "export")).toBe("active");
  });

  it("maps free-text design prompts to deterministic fallback kinds", () => {
    expect(cutKindFromPrompt("a full song")).toBe("full");
    expect(cutKindFromPrompt("short teaser")).toBe("teaser");
    expect(cutKindFromPrompt("best moments")).toBe("highlights");
  });

  it("builds the correct typed cut-plan schema for each project shape", () => {
    const base = { folder: "/project<&", stages: [], project: { name: "P", artifacts: ["sources"] } };
    expect(buildAutoPrompt("summary", base)).toContain('"clips"');
    expect(buildAutoPrompt("angles", { ...base, project: { ...base.project, artifacts: ["multicam"] } })).toContain('"switches"');
  });

  it("renders the initial shell with one Kerf root and escaped dynamic-safe controls", () => {
    const html = DesktopApp().toString();
    expect(html).toContain('data-ui-runtime="kerfjs"');
    expect(html).toContain('data-action="stage"');
    expect(html).toContain('data-screen="setup"');
    expect(html).not.toContain("onclick=");
  });
});
