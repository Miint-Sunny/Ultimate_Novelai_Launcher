use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::net::TcpListener;
use tauri::Manager;

struct SidecarProcess(Mutex<Option<Child>>);

impl Drop for SidecarProcess {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(child) = guard.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// Per-session shared secret handed to both the sidecar (via env) and the webview
/// (via the `sidecar_auth_token` command) so only this app's frontend can reach the
/// sidecar's sensitive endpoints. Regenerated on every launch.
struct SidecarAuth(String);

#[tauri::command]
fn sidecar_auth_token(auth: tauri::State<SidecarAuth>) -> String {
    auth.0.clone()
}

fn generate_auth_token() -> String {
    let mut buf = [0u8; 32];
    if getrandom::getrandom(&mut buf).is_err() {
        // Fail open: with no token the sidecar leaves its auth check disabled rather
        // than bricking the app. Extremely unlikely on a supported OS.
        return String::new();
    }
    buf.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let auth_token = generate_auth_token();
    let sidecar_token = auth_token.clone();
    tauri::Builder::default()
        .manage(SidecarAuth(auth_token))
        .invoke_handler(tauri::generate_handler![sidecar_auth_token])
        .setup(move |app| {
            let child = spawn_python_sidecar(&sidecar_token);
            app.manage(SidecarProcess(Mutex::new(child)));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Ultimate Novelai launcher");
}

fn spawn_python_sidecar(auth_token: &str) -> Option<Child> {
    let skip_sidecar = std::env::var("ULTIMATE_NOVELAI_LAUNCHER_SKIP_SIDECAR")
        .or_else(|_| std::env::var("NAI_STUDIO_SKIP_SIDECAR"))
        .ok();
    if skip_sidecar.as_deref() == Some("1") {
        return None;
    }

    let root = project_root();
    let requested_port = std::env::var("ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_PORT")
        .or_else(|_| std::env::var("NAI_STUDIO_SIDECAR_PORT"))
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(38176);
    let port = available_port(requested_port).to_string();

    match Command::new(python_executable(&root))
        .arg("-m")
        .arg("sidecar.server")
        .current_dir(root)
        .env("ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_HOST", "127.0.0.1")
        .env("ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_PORT", &port)
        .env("ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_AUTH", auth_token)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(child) => {
            eprintln!("Ultimate Novelai launcher sidecar started on 127.0.0.1:{port}");
            Some(child)
        }
        Err(error) => {
            eprintln!("failed to start Ultimate Novelai launcher sidecar: {error}");
            None
        }
    }
}

fn available_port(preferred: u16) -> u16 {
    for port in preferred..=38210 {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
    preferred
}

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri must be inside the project root")
        .to_path_buf()
}

fn python_executable(root: &PathBuf) -> PathBuf {
    let unix_venv = root.join(".venv").join("bin").join("python");
    if unix_venv.exists() {
        return unix_venv;
    }

    let windows_venv = root.join(".venv").join("Scripts").join("python.exe");
    if windows_venv.exists() {
        return windows_venv;
    }

    PathBuf::from("python3")
}
