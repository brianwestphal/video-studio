// Register the app's own `#[tauri::command]`s with the ACL. KEEP THIS LIST IN SYNC
// with the `generate_handler!` list in src/lib.rs and the grants in
// capabilities/default.json.
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "sidecar_send",
            "open_video",
            "open_folder",
            "reveal_in_finder",
        ]),
    ))
    .expect("failed to run tauri-build");
}
