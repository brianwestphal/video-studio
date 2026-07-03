// video-studio desktop shell (VS-76). The Rust side owns the native window and a
// long-lived Node sidecar (desktop/sidecar/host.mjs) that runs the existing
// pipeline. This mirrors the glassbox pattern: spawn Node, read its stdout, and
// forward each NDJSON line to the webview as a `sidecar` event. The frontend talks
// back through the `sidecar_send` command (writes to the host's stdin). All protocol
// shaping + step logic lives in the sidecar's PURE, unit-tested JS modules; this file
// is the thin native bridge.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

// Holds the running sidecar so we can write to its stdin and reap it on exit.
#[derive(Default)]
struct Sidecar {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
}

// Absolute path to desktop/sidecar/host.mjs, resolved from this crate's location
// (desktop/src-tauri) at compile time. Bundled-resource resolution is VS-89.
fn host_script_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("sidecar")
        .join("host.mjs")
}

// Send a raw NDJSON request line to the sidecar's stdin. The frontend passes an
// already-serialized protocol message (see desktop/sidecar/protocol.mjs).
#[tauri::command]
fn sidecar_send(state: tauri::State<Sidecar>, payload: String) -> Result<(), String> {
    let mut guard = state.stdin.lock().map_err(|e| e.to_string())?;
    let stdin = guard.as_mut().ok_or("sidecar not running")?;
    stdin
        .write_all(format!("{}\n", payload).as_bytes())
        .map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
    Ok(())
}

// Native "open a video" file dialog. Returns the chosen path, or None if cancelled.
#[tauri::command]
fn open_video(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .add_filter("Video", &["mp4", "mov", "m4v", "mkv", "webm", "avi"])
        .blocking_pick_file()
        .map(|p| p.to_string())
}

// Native "choose a project folder" dialog. Returns the chosen directory, or None.
#[tauri::command]
fn open_folder(app: tauri::AppHandle) -> Option<String> {
    app.dialog().file().blocking_pick_folder().map(|p| p.to_string())
}

// Reveal a finished file in Finder (select it), the macOS `open -R <path>`.
#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    Command::new("open")
        .args(["-R", &path])
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn start_sidecar(app: &tauri::AppHandle) {
    let script = host_script_path();
    let mut child = match Command::new("node")
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            let _ = app.emit("sidecar-error", format!("failed to spawn node sidecar: {e}"));
            return;
        }
    };

    let stdin = child.stdin.take();
    let stdout = child.stdout.take();

    let state = app.state::<Sidecar>();
    *state.stdin.lock().unwrap() = stdin;

    // Drain stdout on a background thread, forwarding each line as a `sidecar` event.
    if let Some(stdout) = stdout {
        let handle = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                let _ = handle.emit("sidecar", line);
            }
        });
    }

    *state.child.lock().unwrap() = Some(child);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Sidecar::default())
        .invoke_handler(tauri::generate_handler![
            sidecar_send,
            open_video,
            open_folder,
            reveal_in_finder
        ])
        .setup(|app| {
            start_sidecar(&app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // Take the child out under the lock, then drop the guard before
                // using it (avoids the MutexGuard temporary outliving `state`).
                let child = window.state::<Sidecar>().child.lock().unwrap().take();
                if let Some(mut child) = child {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running video-studio desktop app");
}
