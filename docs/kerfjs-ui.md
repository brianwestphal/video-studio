# Kerfjs UI standard (VS-115)

Every interactive video-studio user interface uses **kerfjs** as its rendering and
reactivity runtime. This keeps the project framework-light while replacing hand-built HTML,
whole-container `innerHTML` updates, and per-render event rebinding with typed JSX, signals,
keyed reconciliation, and delegated events.

Status: **Foundation shipped; migrations planned.** Kerfjs, its ESLint plugin, browser TSX
typechecking/bundling, shared UI utilities, and a component-test seam ship in VS-121. The
desktop webview predates this requirement and remains VS-119; the multi-camera review page
is migrated in VS-120.

## 1. Scope

- **R-KERF1** Kerfjs applies to every shipped interactive UI: the Tauri webview under
  `desktop/ui` and the multi-camera review UI served by `tools/review-switches.mjs`. New UI
  surfaces must start on kerfjs. Static documentation wireframes, generated SVG/video
  overlays, and CLI text output are not application UIs and are out of scope.
- **R-KERF2** *(foundation built — VS-121)* UI source uses TypeScript/TSX with `jsxImportSource: "kerfjs"`. Components
  return kerfjs `SafeHtml`/JSX; string children remain auto-escaped. Pre-escaped content may
  enter through `raw()` only at a documented trust boundary.

## 2. Rendering, state, and events

- **R-KERF3** Reactive UI state uses module or session-scoped `signal`, `computed`, `effect`,
  or `defineStore`, and UI roots render through `mount()`/`morph()`. A subtree owned by a
  media player or another imperative library must use the narrow kerf preservation escape
  hatch and document that ownership boundary.
- **R-KERF4** Dynamic lists carry stable `data-key` identities. Reordering a project,
  permission, activity, switch, or caption list must preserve focus, selection, and local DOM
  state rather than matching rows positionally.
- **R-KERF5** Events use `delegate()`/`delegateCapture()` from a stable root. Registrations
  with a lifetime shorter than the page retain and invoke their disposer. JSX does not create
  fresh inline event-handler closures on every render.
- **R-KERF6** UI rendering does not assemble dynamic markup with string concatenation or
  assign dynamic content through `innerHTML`. DOM-only integration boundaries use kerfjs
  `toElement`, `raw`, or a preserved subtree with explicit escaping and rationale.

## 3. Tooling and verification

- **R-KERF7** *(built — VS-121)* `kerfjs` is a direct runtime dependency and `eslint-plugin-kerfjs` is enabled
  for UI source. The recommended rules enforce delegated-event disposal, keyed iteration,
  no nested mounts, no inline JSX event closures, and module-level JSX augmentation as
  supported by the installed version.
- **R-KERF8** UI behavior is protected at two levels: pure/store/component unit tests cover
  state transitions and rendered structure; browser or desktop automation covers at least
  the primary project flow and multi-camera review flow. Migration must preserve keyboard,
  focus, dialog, iframe/media, and Tauri-bridge behavior.

## 4. Migration boundaries

1. Add the shared TSX build/lint/test foundation and a small UI utility layer.
2. Migrate the Tauri webview screen-by-screen, keeping the sidecar protocol unchanged.
3. Extract and migrate the review server's inline page to typed kerfjs client components,
   preserving the existing HTTP API and media-player ownership boundaries.
