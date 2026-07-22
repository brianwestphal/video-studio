import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const bundle = readFileSync(new URL("../../dist/ui/review-entry.js", import.meta.url));
const requests = [];
let server;
let origin;

const baseSegment = {
  index: 0,
  atSeconds: 2,
  endSeconds: 6,
  previewStart: 0,
  previewEnd: 8,
  chosen: "wide",
  pick: "wide",
  note: "",
  why: "speaker",
  confidence: 0.4,
  candidates: [
    { id: "wide", url: "clip/wide.mp4", auto: true },
    { id: "close", url: "clip/close.mp4" },
  ],
};

const json = (response, value) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
};

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/") {
      response.setHeader("content-type", "text/html");
      response.end('<div id="review-app">Loading…</div><script src="review-entry.js"></script>');
      return;
    }
    if (url.pathname === "/review-entry.js") {
      response.setHeader("content-type", "text/javascript");
      response.end(bundle);
      return;
    }
    if (url.pathname.startsWith("/clip/") || url.pathname.startsWith("/source/")) {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (url.pathname === "/data") {
      json(response, { groupId: "browser-fixture", canRepropose: true, segments: [baseSegment] });
      return;
    }
    if (url.pathname === "/assembled") {
      json(response, {
        timelineEnd: 12,
        angles: [
          { id: "wide", url: "source/wide", offset: 0, rate: 1 },
          { id: "close", url: "source/close", offset: 0, rate: 1 },
        ],
        switches: [{ atSeconds: 0, memberId: "wide" }],
        rationale: [{ flagged: true }],
      });
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ path: url.pathname, body: body ? JSON.parse(body) : {} });
    if (url.pathname === "/save") json(response, { changed: 1, switchesPath: "switches.json", exportHint: "export" });
    else if (url.pathname === "/split") json(response, { split: true, segments: [baseSegment, { ...baseSegment, index: 1, atSeconds: 4 }] });
    else if (url.pathname === "/add-review") json(response, { segments: [baseSegment, { ...baseSegment, index: 1, atSeconds: 4 }] });
    else if (url.pathname === "/repropose") json(response, { segments: [baseSegment] });
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("review interactions use the shipped Kerf bundle and existing HTTP API", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    globalThis.HTMLMediaElement.prototype.play = async function play() { this.dispatchEvent(new globalThis.Event("playing")); };
    globalThis.HTMLMediaElement.prototype.pause = function pause() { this.dispatchEvent(new globalThis.Event("pause")); };
  });
  await page.goto(origin);
  await expect(page.locator("[data-ui-runtime=kerfjs]")).toBeVisible();
  await expect(page.locator(".seg")).toHaveCount(1);
  await expect(page.locator(".seg")).toHaveAttribute("data-segment", "0");

  const videos = page.locator(".seg video");
  await page.locator('[data-candidate="close"] [data-action="pick"]').click();
  expect(pageErrors).toEqual([]);
  await expect(page.locator('[data-candidate="close"]')).toHaveClass(/sel/);
  await page.locator('[data-action="note"]').fill("prefer close-up");
  await videos.evaluateAll((nodes) => nodes.forEach((video) => {
    Object.defineProperty(video, "duration", { value: 8, configurable: true });
    Object.defineProperty(video, "currentTime", { value: 0, writable: true, configurable: true });
  }));
  await page.locator('[data-action="segment-play"]').click();
  await expect(page.locator(".seg")).toHaveClass(/active/);
  await expect(page.locator('[data-candidate="close"] video')).not.toHaveJSProperty("muted", true);
  await page.locator('[data-action="segment-seek"]').fill("500");
  await expect(videos.first()).toHaveJSProperty("currentTime", 4);
  await expect(videos.nth(1)).toHaveJSProperty("currentTime", 4);

  await page.locator('[data-action="save"]').click();
  await expect(page.locator("#status")).toContainText("1 change(s) saved");
  expect(requests.find((entry) => entry.path === "/save")?.body).toEqual({
    choices: [{ index: 0, memberId: "close", note: "prefer close-up" }],
  });

  await page.locator('[data-action="timeline-toggle"]').click();
  await expect(page.locator("#tldrawer")).toHaveClass(/open/);
  await page.locator('[data-tl="split"]').click();
  await expect(page.locator(".seg")).toHaveCount(2);
  await page.locator('[data-tl="add"]').click();
  await page.locator('[data-action="repropose"]').click();
  await expect(page.locator("#status")).toContainText("re-proposed");
  expect(requests.map((entry) => entry.path)).toEqual(expect.arrayContaining(["/split", "/add-review", "/repropose"]));
});
