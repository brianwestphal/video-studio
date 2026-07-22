import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const assets = {
  "/": ["text/html", readFileSync(new URL("../../desktop/ui/index.html", import.meta.url))],
  "/app.js": ["text/javascript", readFileSync(new URL("../../desktop/ui/app.js", import.meta.url))],
  "/styles.css": ["text/css", readFileSync(new URL("../../desktop/ui/styles.css", import.meta.url))],
};
let server;
let origin;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const asset = assets[new URL(request.url ?? "/", "http://localhost").pathname];
    if (!asset) { response.statusCode = 404; response.end(); return; }
    response.setHeader("content-type", asset[0]); response.end(asset[1]);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });

test("desktop stages, protocol flows, permissions, and interactions run through Kerf", async ({ page }) => {
  await page.addInitScript(() => {
    const requests = [];
    let listener;
    const stages = ["setup", "new-project", "analyze", "design", "export"].map((key) => ({ key, label: key === "new-project" ? "New Project" : key[0].toUpperCase() + key.slice(1), state: key === "setup" ? "done" : "idle" }));
    const snapshot = { folder: "/tmp/demo", project: { name: "Demo", artifacts: ["multicam", "audioEvents", "switches"] }, stages };
    const emit = (message) => globalThis.setTimeout(() => listener?.({ payload: JSON.stringify(message) }), 0);
    globalThis.__desktopRequests = requests;
    globalThis.__emitSidecar = emit;
    globalThis.__TAURI__ = {
      event: { listen: async (_name, callback) => { listener = callback; return () => {}; } },
      core: { invoke: async (command, args = {}) => {
        if (command === "open_folder") return "/tmp/demo";
        if (command !== "sidecar_send") return null;
        const message = JSON.parse(args.payload); requests.push(message);
        if (message.type !== "request") return null;
        const result = (data) => emit({ type: "result", id: message.id, data });
        if (message.step === "config-get" || message.step.startsWith("config-")) result({ recentProjects: ["/tmp/demo"], policy: {}, rules: [] });
        else if (message.step === "doctor") result({ rows: [{ label: "ffmpeg", status: "ok", found: true, required: true }] });
        else if (message.step === "project-open" || message.step === "project-create") result(snapshot);
        else if (message.step === "agent-run") { emit({ type: "progress", id: message.id, progress: { label: "Planning", detail: "the edit" } }); result({ sessionId: "session-1", landedCut: true }); }
        else if (message.step === "review-start") result({ url: "about:blank" });
        else if (message.step.startsWith("export-")) result({ outPath: "/tmp/out.mp4" });
        else result({});
        return null;
      } },
    };
  });
  await page.goto(origin);
  await expect(page.locator('[data-ui-runtime="kerfjs"]')).toBeVisible();
  await page.getByRole("button", { name: "Check tools" }).click();
  await expect(page.locator(".doctor-row")).toContainText("ffmpeg");

  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByRole("button", { name: "Open project folder…" }).click();
  await expect(page.locator(".project-name")).toHaveText("Demo");
  await page.getByRole("button", { name: "Design" }).click();
  await expect(page.locator('[data-screen="design"]')).toBeVisible();
  await page.getByRole("button", { name: "Teaser" }).click();
  await expect(page.locator("textarea")).toHaveValue(/teaser/);
  await page.getByRole("button", { name: "Make my cut" }).click();
  await expect(page.locator('[data-screen="export"]')).toBeVisible();
  await page.locator('[data-kind="mp4"] [data-action="export-run"]').click();
  await expect(page.locator('[data-kind="mp4"] .export-status')).toHaveText("done");
  await expect(page.locator('[data-kind="mp4"] [data-action="reveal"]')).toBeVisible();

  await page.getByRole("button", { name: "Design" }).click();
  await page.getByRole("button", { name: "Open timeline editor" }).click();
  await expect(page.locator("iframe.review-frame")).toBeVisible();
  await page.getByRole("button", { name: "Permissions" }).click();
  await expect(page.locator(".perm-toggle")).toHaveCount(6);

  await page.evaluate(() => globalThis.__emitSidecar({ type: "interaction-request", interactionId: "ask-1", interaction: { kind: "permission", title: "Approval needed", description: "Run tool", toolName: "Bash", category: "other-shell", input: { command: "echo" } } }));
  await expect(page.locator("#interaction-dialog")).toContainText("Approval needed");
  await page.getByRole("button", { name: "Allow once" }).click();
  const messages = await page.evaluate(() => globalThis.__desktopRequests);
  expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ type: "interaction-response", interactionId: "ask-1", decision: "allow-once" })]));
  expect(messages.map((message) => message.step).filter(Boolean)).toEqual(expect.arrayContaining(["doctor", "project-open", "agent-run", "export-mp4", "review-start", "config-get"]));
});
