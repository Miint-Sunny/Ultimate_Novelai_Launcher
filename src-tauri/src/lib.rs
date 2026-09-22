use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child as DevelopmentChild, Command as DevelopmentCommand, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{path::BaseDirectory, Manager};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

const SIDECAR_SERVICE: &str = "ultimate-novelai-launcher-sidecar";
const SIDECAR_PROTOCOL: u32 = 1;
// Bounds how long a broken sidecar keeps the window on its startup screen; nothing
// blocks on it any more. The first start after install still has the system validate
// every native module of the bundled sidecar, which Windows Defender makes slow.
const READY_TIMEOUT: Duration = Duration::from_secs(120);
// A PyInstaller onedir build shipped under `bundle.resources` in tauri.conf.json: the
// executable next to its `_internal/` folder. (It was a onefile externalBin, which
// unpacked every native module into a fresh temp directory on each launch and had
// the system re-validate them all: 4-12 s per start instead of 0.4 s.)
const BUNDLED_SIDECAR: &str = if cfg!(windows) {
    "sidecar/ultimate-novelai-sidecar.exe"
} else {
    "sidecar/ultimate-novelai-sidecar"
};
const DRAIN_TIMEOUT: Duration = Duration::from_secs(8);
const MANAGED_SIDECAR_PORT: &str = "0";

const SIDECAR_HOST_ENV: &str = "ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_HOST";
const SIDECAR_PORT_ENV: &str = "ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_PORT";
const SIDECAR_AUTH_ENV: &str = "ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_AUTH";
const SIDECAR_INSTANCE_ENV: &str = "ULTIMATE_NOVELAI_LAUNCHER_INSTANCE_ID";
const SIDECAR_PROTOCOL_ENV: &str = "ULTIMATE_NOVELAI_LAUNCHER_PROTOCOL";

#[derive(Clone, Debug, Serialize)]
struct SidecarConnection {
    endpoint: String,
    token: String,
    instance_id: String,
    protocol: u32,
    port: u16,
}

#[derive(Debug, Deserialize)]
struct ReadyHandshake {
    event: String,
    service: String,
    instance_id: String,
    protocol: u32,
    port: u16,
}

enum SidecarChild {
    Bundled {
        child: CommandChild,
        terminated: Arc<AtomicBool>,
    },
    Development(DevelopmentChild),
}

struct SidecarProcess {
    child: Arc<Mutex<Option<SidecarChild>>>,
    readiness: Arc<SidecarReadiness>,
}

/// How far the sidecar has got, settled exactly once off the main thread.
///
/// Setup used to block on the handshake. The bundled sidecar was then a PyInstaller
/// onefile binary that took seconds to start on every launch, so the window froze
/// through that and a start slower than the deadline panicked inside
/// `did_finish_launching` — an abort, not an error. Now the window opens at once and
/// the frontend waits on `sidecar_connection` instead.
struct SidecarReadiness {
    outcome: Mutex<Option<Result<SidecarConnection, String>>>,
    settled: Condvar,
}

impl SidecarReadiness {
    fn pending() -> Arc<Self> {
        Arc::new(Self {
            outcome: Mutex::new(None),
            settled: Condvar::new(),
        })
    }

    fn settled_with(outcome: Result<SidecarConnection, String>) -> Arc<Self> {
        let readiness = Self::pending();
        readiness.settle(outcome);
        readiness
    }

    /// The first outcome wins; later ones are ignored.
    fn settle(&self, outcome: Result<SidecarConnection, String>) {
        let mut guard = self
            .outcome
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.is_none() {
            *guard = Some(outcome);
        }
        self.settled.notify_all();
    }

    fn wait(&self, timeout: Duration) -> Result<SidecarConnection, String> {
        let guard = self
            .outcome
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (guard, _) = self
            .settled
            .wait_timeout_while(guard, timeout, |outcome| outcome.is_none())
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .clone()
            .unwrap_or_else(|| Err("sidecar is still starting".to_string()))
    }

    fn connection(&self) -> Option<SidecarConnection> {
        self.outcome
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .and_then(|outcome| outcome.as_ref().ok())
            .cloned()
    }
}

#[derive(Debug, Eq, PartialEq)]
enum ShutdownOutcome {
    AlreadyStopped,
    Exited { drain_accepted: bool },
    Forced { drain_accepted: bool },
}

impl SidecarProcess {
    /// A sidecar that could not even be spawned is reported in the window like any
    /// other startup failure, never as a crash.
    fn failed(error: String) -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            readiness: SidecarReadiness::settled_with(Err(error)),
        }
    }

    fn shutdown(&self) {
        let _ = self.shutdown_with_timeout(DRAIN_TIMEOUT);
    }

    fn shutdown_with_timeout(&self, timeout: Duration) -> ShutdownOutcome {
        // A poisoned mutex must not turn into an orphaned sidecar.  No user code
        // runs while this mutex is held, so recovering its value is safe here.
        let mut guard = self
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(mut child) = guard.take() else {
            return ShutdownOutcome::AlreadyStopped;
        };

        let deadline = Instant::now() + timeout;
        // Before its handshake the sidecar has no port to drain through.
        let drain_accepted = self
            .readiness
            .connection()
            .is_some_and(|connection| request_graceful_shutdown(&connection, deadline));
        while Instant::now() < deadline {
            if child_has_exited(&mut child) {
                return ShutdownOutcome::Exited { drain_accepted };
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            thread::sleep(remaining.min(Duration::from_millis(100)));
        }

        kill_child(child);
        ShutdownOutcome::Forced { drain_accepted }
    }
}

fn kill_child(child: SidecarChild) {
    match child {
        SidecarChild::Bundled { child, .. } => {
            let _ = child.kill();
        }
        SidecarChild::Development(mut child) => {
            if child.kill().is_ok() {
                let _ = child.wait();
            }
        }
    }
}

impl Drop for SidecarProcess {
    fn drop(&mut self) {
        // Fallback for setup failures or an embedding that does not emit the
        // normal Tauri exit event.  The explicit RunEvent handler below performs
        // the same bounded shutdown while the async shell event reader is alive.
        self.shutdown();
    }
}

/// Resolves once the sidecar has settled. Waits on a blocking-pool thread: a
/// synchronous command would park the main thread and freeze the window again.
async fn settled_connection(readiness: Arc<SidecarReadiness>) -> Result<SidecarConnection, String> {
    // Outlast the handshake deadline so callers see the settled error, not "still starting".
    tauri::async_runtime::spawn_blocking(move || {
        readiness.wait(READY_TIMEOUT + Duration::from_secs(5))
    })
    .await
    .map_err(|error| format!("sidecar readiness wait failed: {error}"))?
}

#[tauri::command]
async fn sidecar_connection(
    process: tauri::State<'_, SidecarProcess>,
) -> Result<SidecarConnection, String> {
    settled_connection(Arc::clone(&process.readiness)).await
}

/// Kept for one bundled release while callers move to `sidecar_connection`.
#[tauri::command]
async fn sidecar_auth_token(process: tauri::State<'_, SidecarProcess>) -> Result<String, String> {
    Ok(settled_connection(Arc::clone(&process.readiness))
        .await?
        .token)
}

#[tauri::command]
async fn sidecar_endpoint(process: tauri::State<'_, SidecarProcess>) -> Result<String, String> {
    Ok(settled_connection(Arc::clone(&process.readiness))
        .await?
        .endpoint)
}

fn random_hex<const N: usize>() -> Result<String, getrandom::Error> {
    let mut bytes = [0_u8; N];
    getrandom::getrandom(&mut bytes)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let auth_token = if should_skip_sidecar() {
        std::env::var("ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_AUTH")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| random_hex::<32>().expect("failed to obtain secure random bytes"))
    } else {
        random_hex::<32>().expect("failed to obtain secure random bytes")
    };
    let instance_id = random_hex::<16>().expect("failed to obtain secure random bytes");
    let setup_token = auth_token.clone();
    let setup_instance = instance_id.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            sidecar_connection,
            sidecar_auth_token,
            sidecar_endpoint
        ])
        .setup(move |app| {
            // An error returned here panics inside did_finish_launching, which aborts
            // the app; a sidecar that cannot start is shown in the window instead.
            let process = spawn_sidecar(app.handle(), &setup_token, &setup_instance)
                .unwrap_or_else(|error| {
                    eprintln!("sidecar failed to start: {error}");
                    SidecarProcess::failed(error)
                });
            app.manage(process);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Ultimate Novelai Launcher");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            // Drain while the Tauri async runtime and the bundled-child event
            // reader are still alive, after exit can no longer be prevented.
            // Drop remains an idempotent fallback for run-return embeddings.
            if let Some(process) = app_handle.try_state::<SidecarProcess>() {
                process.shutdown();
            }
        }
    });
}

fn spawn_sidecar(
    app: &tauri::AppHandle,
    auth_token: &str,
    instance_id: &str,
) -> Result<SidecarProcess, String> {
    if should_skip_sidecar() {
        return Ok(skipped_sidecar(auth_token, instance_id));
    }

    if cfg!(debug_assertions) {
        spawn_development_sidecar(auth_token, instance_id)
    } else {
        spawn_bundled_sidecar(app, auth_token, instance_id)
    }
}

fn spawn_development_sidecar(
    auth_token: &str,
    instance_id: &str,
) -> Result<SidecarProcess, String> {
    let root = project_root();
    let command = development_sidecar_command(&root, auth_token, instance_id);
    spawn_development_command(command, auth_token, instance_id)
}

fn managed_sidecar_environment(auth_token: &str, instance_id: &str) -> [(&'static str, String); 5] {
    [
        (SIDECAR_HOST_ENV, "127.0.0.1".to_string()),
        (SIDECAR_PORT_ENV, MANAGED_SIDECAR_PORT.to_string()),
        (SIDECAR_AUTH_ENV, auth_token.to_string()),
        (SIDECAR_INSTANCE_ENV, instance_id.to_string()),
        (SIDECAR_PROTOCOL_ENV, SIDECAR_PROTOCOL.to_string()),
    ]
}

fn apply_managed_sidecar_environment(
    command: &mut DevelopmentCommand,
    auth_token: &str,
    instance_id: &str,
) {
    for (name, value) in managed_sidecar_environment(auth_token, instance_id) {
        command.env(name, value);
    }
}

fn development_sidecar_command(
    root: &Path,
    auth_token: &str,
    instance_id: &str,
) -> DevelopmentCommand {
    let mut command = DevelopmentCommand::new(python_executable(root));
    command
        .arg("-m")
        .arg("sidecar.bootstrap")
        .current_dir(root)
        .env("ULTIMATE_NOVELAI_LAUNCHER_ALLOW_DEV_ORIGINS", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    apply_managed_sidecar_environment(&mut command, auth_token, instance_id);
    command
}

fn spawn_development_command(
    mut command: DevelopmentCommand,
    auth_token: &str,
    instance_id: &str,
) -> Result<SidecarProcess, String> {
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start development sidecar: {error}"))?;

    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("development sidecar stdout was not piped".to_string());
    };
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut first_line = Some(sender);
        for line in reader.lines() {
            match line {
                Ok(line) if first_line.is_some() => {
                    if !line.trim().is_empty() {
                        if let Some(sender) = first_line.take() {
                            let _ = sender.send(line);
                        }
                    }
                }
                Ok(line) => eprintln!("sidecar: {line}"),
                Err(error) => {
                    eprintln!("sidecar stdout error: {error}");
                    break;
                }
            }
        }
    });

    Ok(watch_for_handshake(
        SidecarChild::Development(child),
        receiver,
        auth_token,
        instance_id,
    ))
}

fn spawn_bundled_sidecar(
    app: &tauri::AppHandle,
    auth_token: &str,
    instance_id: &str,
) -> Result<SidecarProcess, String> {
    let program = app
        .path()
        .resolve(BUNDLED_SIDECAR, BaseDirectory::Resource)
        .map_err(|error| format!("bundled sidecar is unavailable: {error}"))?;
    let mut command = app.shell().command(program);
    for (name, value) in managed_sidecar_environment(auth_token, instance_id) {
        command = command.env(name, value);
    }
    let (mut events, child) = command
        .spawn()
        .map_err(|error| format!("failed to start bundled sidecar: {error}"))?;

    let terminated = Arc::new(AtomicBool::new(false));
    let terminated_for_task = Arc::clone(&terminated);
    let (sender, receiver) = mpsc::sync_channel(1);
    tauri::async_runtime::spawn(async move {
        let mut sender = Some(sender);
        let mut stdout_buffer = Vec::<u8>::new();
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    stdout_buffer.extend_from_slice(&bytes);
                    while let Some(index) = stdout_buffer.iter().position(|byte| *byte == b'\n') {
                        let line = String::from_utf8_lossy(&stdout_buffer[..index])
                            .trim()
                            .to_string();
                        stdout_buffer.drain(..=index);
                        if line.is_empty() {
                            continue;
                        }
                        if let Some(sender) = sender.take() {
                            let _ = sender.send(line);
                        } else {
                            eprintln!("sidecar: {line}");
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    eprintln!("sidecar error: {}", String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Error(error) => eprintln!("sidecar process error: {error}"),
                CommandEvent::Terminated(payload) => {
                    terminated_for_task.store(true, Ordering::Release);
                    eprintln!("sidecar terminated with code {:?}", payload.code);
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(watch_for_handshake(
        SidecarChild::Bundled { child, terminated },
        receiver,
        auth_token,
        instance_id,
    ))
}

/// Hands the child to a `SidecarProcess` at once and settles its readiness from the
/// first stdout line on a background thread. A child that never becomes usable is
/// killed there, so it cannot sit on its port or the data-directory lock until the
/// app quits.
fn watch_for_handshake(
    child: SidecarChild,
    receiver: mpsc::Receiver<String>,
    auth_token: &str,
    instance_id: &str,
) -> SidecarProcess {
    let child = Arc::new(Mutex::new(Some(child)));
    let readiness = SidecarReadiness::pending();
    let waiting_child = Arc::clone(&child);
    let waiting_readiness = Arc::clone(&readiness);
    let auth_token = auth_token.to_string();
    let instance_id = instance_id.to_string();
    thread::spawn(move || {
        let outcome = receive_handshake(receiver, &instance_id, READY_TIMEOUT)
            .map(|handshake| connection_from_handshake(handshake, &auth_token));
        if let Err(error) = &outcome {
            eprintln!("sidecar did not become ready: {error}");
            let unusable = waiting_child
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            if let Some(unusable) = unusable {
                kill_child(unusable);
            }
        }
        waiting_readiness.settle(outcome);
    });
    SidecarProcess { child, readiness }
}

fn receive_handshake(
    receiver: mpsc::Receiver<String>,
    expected_instance: &str,
    timeout: Duration,
) -> Result<ReadyHandshake, String> {
    let line = receiver
        .recv_timeout(timeout)
        .map_err(|error| match error {
            mpsc::RecvTimeoutError::Timeout => format!(
                "sidecar did not produce a readiness handshake within {} seconds",
                timeout.as_secs()
            ),
            mpsc::RecvTimeoutError::Disconnected => {
                "sidecar exited before producing a readiness handshake".to_string()
            }
        })?;
    let handshake: ReadyHandshake = serde_json::from_str(&line)
        .map_err(|error| format!("invalid sidecar readiness handshake: {error}"))?;
    if handshake.event != "ready"
        || handshake.service != SIDECAR_SERVICE
        || handshake.instance_id != expected_instance
        || handshake.protocol != SIDECAR_PROTOCOL
        || handshake.port == 0
    {
        return Err("sidecar readiness handshake did not match this desktop instance".to_string());
    }
    Ok(handshake)
}

fn connection_from_handshake(handshake: ReadyHandshake, auth_token: &str) -> SidecarConnection {
    SidecarConnection {
        endpoint: format!("http://127.0.0.1:{}", handshake.port),
        token: auth_token.to_string(),
        instance_id: handshake.instance_id,
        protocol: handshake.protocol,
        port: handshake.port,
    }
}

fn skipped_sidecar(auth_token: &str, instance_id: &str) -> SidecarProcess {
    let port = match requested_port() {
        0 => 38176,
        port => port,
    };
    let endpoint = std::env::var("ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("http://127.0.0.1:{port}"));
    SidecarProcess {
        child: Arc::new(Mutex::new(None)),
        readiness: SidecarReadiness::settled_with(Ok(SidecarConnection {
            endpoint: endpoint.trim_end_matches('/').to_string(),
            token: auth_token.to_string(),
            instance_id: instance_id.to_string(),
            protocol: SIDECAR_PROTOCOL,
            port,
        })),
    }
}

fn child_has_exited(child: &mut SidecarChild) -> bool {
    match child {
        SidecarChild::Bundled { terminated, .. } => terminated.load(Ordering::Acquire),
        SidecarChild::Development(child) => child.try_wait().ok().flatten().is_some(),
    }
}

fn request_graceful_shutdown(connection: &SidecarConnection, deadline: Instant) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], connection.port));
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return false;
    }
    let Ok(mut stream) =
        TcpStream::connect_timeout(&address, remaining.min(Duration::from_millis(500)))
    else {
        return false;
    };
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return false;
    }
    let _ = stream.set_write_timeout(Some(remaining));
    let _ = stream.set_read_timeout(Some(remaining));
    let request = format!(
        "POST /api/v1/system/drain HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}",
        connection.port, connection.token
    );
    if stream.write_all(request.as_bytes()).is_err() || stream.flush().is_err() {
        return false;
    }
    let mut reader = BufReader::new(stream);
    let mut status_line = String::new();
    if reader.read_line(&mut status_line).is_err() {
        return false;
    }
    matches!(status_line.split_whitespace().nth(1), Some("200"))
}

fn should_skip_sidecar() -> bool {
    let value = std::env::var("ULTIMATE_NOVELAI_LAUNCHER_SKIP_SIDECAR")
        .or_else(|_| std::env::var("NAI_STUDIO_SKIP_SIDECAR"))
        .ok();
    value.as_deref() == Some("1")
}

fn requested_port() -> u16 {
    std::env::var("ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_PORT")
        .or_else(|_| std::env::var("NAI_STUDIO_SIDECAR_PORT"))
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(0)
}

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri must be inside the project root")
        .to_path_buf()
}

fn python_executable(root: &Path) -> PathBuf {
    let unix_venv = root.join(".venv").join("bin").join("python");
    if unix_venv.exists() {
        return unix_venv;
    }

    let windows_venv = root.join(".venv").join("Scripts").join("python.exe");
    if windows_venv.exists() {
        return windows_venv;
    }

    if cfg!(windows) {
        PathBuf::from("python")
    } else {
        PathBuf::from("python3")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;

    const FAKE_SIDECAR_PROGRAM: &str = r#"
import json
import os
import socket
import sys
import time

expected_token = os.environ["FAKE_EXPECTED_TOKEN"]
expected_instance = os.environ["FAKE_EXPECTED_INSTANCE"]
host = os.environ["ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_HOST"]
port = os.environ["ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_PORT"]
token = os.environ["ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_AUTH"]
instance = os.environ["ULTIMATE_NOVELAI_LAUNCHER_INSTANCE_ID"]
protocol = os.environ["ULTIMATE_NOVELAI_LAUNCHER_PROTOCOL"]

if (
    sys.argv[1:] != ["fixture-argument"]
    or host != "127.0.0.1"
    or port != "0"
    or token != expected_token
    or instance != expected_instance
    or protocol != "1"
):
    sys.exit(10)

server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind((host, int(port)))
server.listen(1)
actual_port = server.getsockname()[1]
if os.environ.get("FAKE_SIDECAR_MODE") == "slow":
    time.sleep(1)
print(json.dumps({
    "event": "ready",
    "service": "ultimate-novelai-launcher-sidecar",
    "instance_id": os.environ.get("FAKE_HANDSHAKE_INSTANCE", instance),
    "protocol": int(os.environ.get("FAKE_HANDSHAKE_PROTOCOL", protocol)),
    "port": actual_port,
}), flush=True)

connection, _ = server.accept()
connection.settimeout(2)
request = b""
while b"\r\n\r\n" not in request:
    chunk = connection.recv(4096)
    if not chunk:
        break
    request += chunk

if os.environ.get("FAKE_SIDECAR_MODE") == "stalled":
    time.sleep(30)
    sys.exit(11)

valid = (
    request.startswith(b"POST /api/v1/system/drain HTTP/1.1\r\n")
    and ("Authorization: Bearer " + expected_token + "\r\n").encode() in request
)
status = b"200 OK" if valid else b"403 Forbidden"
connection.sendall(b"HTTP/1.1 " + status + b"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
connection.close()
server.close()
sys.exit(0 if valid else 12)
"#;

    fn serve_status(status: &str) -> (u16, mpsc::Receiver<String>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind test listener");
        let port = listener.local_addr().expect("listener address").port();
        let (sender, receiver) = mpsc::channel();
        let status = status.to_string();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept drain request");
            stream
                .set_read_timeout(Some(Duration::from_secs(1)))
                .expect("set test timeout");
            let mut payload = vec![0_u8; 4096];
            let read = stream.read(&mut payload).expect("read drain request");
            sender
                .send(String::from_utf8_lossy(&payload[..read]).into_owned())
                .expect("capture drain request");
            write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .expect("write drain response");
        });
        (port, receiver, handle)
    }

    fn serve_stalled(delay: Duration) -> (u16, thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind test listener");
        let port = listener.local_addr().expect("listener address").port();
        let handle = thread::spawn(move || {
            let (_stream, _) = listener.accept().expect("accept drain request");
            thread::sleep(delay);
        });
        (port, handle)
    }

    fn connection(port: u16) -> SidecarConnection {
        SidecarConnection {
            endpoint: format!("http://127.0.0.1:{port}"),
            token: "unit-test-token".to_string(),
            instance_id: "unit-instance".to_string(),
            protocol: SIDECAR_PROTOCOL,
            port,
        }
    }

    fn command_environment(command: &DevelopmentCommand, name: &str) -> Option<String> {
        command
            .get_envs()
            .find(|(candidate, _)| *candidate == name)
            .and_then(|(_, value)| value)
            .map(|value| value.to_string_lossy().into_owned())
    }

    fn fake_sidecar_command(mode: &str, auth_token: &str, instance_id: &str) -> DevelopmentCommand {
        let root = project_root();
        let mut command = DevelopmentCommand::new(python_executable(&root));
        command
            .args(["-u", "-c", FAKE_SIDECAR_PROGRAM, "fixture-argument"])
            .current_dir(root)
            .env("FAKE_EXPECTED_TOKEN", auth_token)
            .env("FAKE_EXPECTED_INSTANCE", instance_id)
            .env("FAKE_SIDECAR_MODE", mode)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        apply_managed_sidecar_environment(&mut command, auth_token, instance_id);
        command
    }

    #[test]
    fn accepts_only_matching_ready_handshake() {
        let (sender, receiver) = mpsc::channel();
        sender
            .send(
                r#"{"event":"ready","service":"ultimate-novelai-launcher-sidecar","instance_id":"expected","protocol":1,"port":41234}"#.to_string(),
            )
            .expect("send handshake");
        let handshake =
            receive_handshake(receiver, "expected", READY_TIMEOUT).expect("valid handshake");
        let resolved = connection_from_handshake(handshake, "secret-token");
        assert_eq!(resolved.endpoint, "http://127.0.0.1:41234");
        assert_eq!(resolved.token, "secret-token");

        let (sender, receiver) = mpsc::channel();
        sender
            .send(
                r#"{"event":"ready","service":"ultimate-novelai-launcher-sidecar","instance_id":"other","protocol":1,"port":41234}"#.to_string(),
            )
            .expect("send mismatched handshake");
        assert!(receive_handshake(receiver, "expected", READY_TIMEOUT).is_err());

        for invalid in [
            r#"{"event":"starting","service":"ultimate-novelai-launcher-sidecar","instance_id":"expected","protocol":1,"port":41234}"#,
            r#"{"event":"ready","service":"other","instance_id":"expected","protocol":1,"port":41234}"#,
            r#"{"event":"ready","service":"ultimate-novelai-launcher-sidecar","instance_id":"expected","protocol":2,"port":41234}"#,
            r#"{"event":"ready","service":"ultimate-novelai-launcher-sidecar","instance_id":"expected","protocol":1,"port":0}"#,
        ] {
            let (sender, receiver) = mpsc::channel();
            sender.send(invalid.to_string()).expect("send handshake");
            assert!(receive_handshake(receiver, "expected", READY_TIMEOUT).is_err());
        }
    }

    #[test]
    fn handshake_errors_tell_a_slow_sidecar_from_one_that_exited() {
        let (_sender, receiver) = mpsc::channel::<String>();
        let error = receive_handshake(receiver, "expected", Duration::from_secs(1))
            .expect_err("no handshake within the deadline");
        assert!(error.contains("within 1 seconds"));

        let (sender, receiver) = mpsc::channel::<String>();
        drop(sender);
        let error = receive_handshake(receiver, "expected", READY_TIMEOUT)
            .expect_err("sidecar went away before its handshake");
        assert!(error.contains("exited before"));
    }

    #[test]
    fn a_slow_sidecar_does_not_hold_up_spawn() {
        let started = Instant::now();
        let process = spawn_development_command(
            fake_sidecar_command("slow", "fixture-token", "fixture-instance"),
            "fixture-token",
            "fixture-instance",
        )
        .expect("spawn fake sidecar");
        assert!(started.elapsed() < Duration::from_millis(900));
        assert_eq!(
            process.readiness.wait(Duration::ZERO).err().as_deref(),
            Some("sidecar is still starting")
        );

        let connection = process
            .readiness
            .wait(Duration::from_secs(10))
            .expect("a slow sidecar still becomes ready");
        assert_ne!(connection.port, 0);
        assert_eq!(
            process.shutdown_with_timeout(Duration::from_secs(2)),
            ShutdownOutcome::Exited {
                drain_accepted: true
            }
        );
    }

    #[test]
    fn a_sidecar_that_cannot_start_is_reported_not_raised() {
        let process = SidecarProcess::failed("failed to start bundled sidecar: fixture".into());
        assert_eq!(
            process.readiness.wait(Duration::ZERO).err().as_deref(),
            Some("failed to start bundled sidecar: fixture")
        );
        assert_eq!(
            process.shutdown_with_timeout(Duration::from_millis(50)),
            ShutdownOutcome::AlreadyStopped
        );
    }

    #[test]
    fn graceful_shutdown_requires_http_200_and_sends_bearer_token() {
        let (port, request, server) = serve_status("200 OK");
        assert!(request_graceful_shutdown(
            &connection(port),
            Instant::now() + Duration::from_secs(2)
        ));
        let request = request.recv().expect("captured request");
        assert!(request.starts_with("POST /api/v1/system/drain HTTP/1.1\r\n"));
        assert!(request.contains("Authorization: Bearer unit-test-token\r\n"));
        server.join().expect("test server exited");

        let (port, _request, server) = serve_status("503 Service Unavailable");
        assert!(!request_graceful_shutdown(
            &connection(port),
            Instant::now() + Duration::from_secs(2)
        ));
        server.join().expect("test server exited");
    }

    #[test]
    fn graceful_shutdown_obeys_its_absolute_deadline() {
        let (port, server) = serve_stalled(Duration::from_millis(150));
        let started = Instant::now();
        assert!(!request_graceful_shutdown(
            &connection(port),
            started + Duration::from_millis(50)
        ));
        assert!(started.elapsed() < Duration::from_millis(500));
        server.join().expect("test server exited");
    }

    #[test]
    fn bounded_shutdown_hard_kills_a_stuck_development_child() {
        let process = spawn_development_command(
            fake_sidecar_command("stalled", "fixture-token", "fixture-instance"),
            "fixture-token",
            "fixture-instance",
        )
        .expect("spawn fake sidecar");
        process
            .readiness
            .wait(Duration::from_secs(10))
            .expect("fake sidecar becomes ready");

        let started = Instant::now();
        let outcome = process.shutdown_with_timeout(Duration::from_millis(50));

        assert_eq!(
            outcome,
            ShutdownOutcome::Forced {
                drain_accepted: false
            }
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(process.child.lock().expect("sidecar child mutex").is_none());
        assert_eq!(
            process.shutdown_with_timeout(Duration::from_millis(50)),
            ShutdownOutcome::AlreadyStopped
        );
    }

    #[test]
    fn fake_sidecar_exercises_spawn_handshake_drain_and_cleanup() {
        let process = spawn_development_command(
            fake_sidecar_command("graceful", "fixture-token", "fixture-instance"),
            "fixture-token",
            "fixture-instance",
        )
        .expect("spawn fake sidecar");
        let connection = process
            .readiness
            .wait(Duration::from_secs(10))
            .expect("fake sidecar becomes ready");

        assert_eq!(connection.token, "fixture-token");
        assert_eq!(connection.instance_id, "fixture-instance");
        assert_eq!(connection.protocol, SIDECAR_PROTOCOL);
        assert_ne!(connection.port, 0);
        assert_eq!(
            connection.endpoint,
            format!("http://127.0.0.1:{}", connection.port)
        );

        assert_eq!(
            process.shutdown_with_timeout(Duration::from_secs(2)),
            ShutdownOutcome::Exited {
                drain_accepted: true
            }
        );
        assert_eq!(
            process.shutdown_with_timeout(Duration::from_millis(50)),
            ShutdownOutcome::AlreadyStopped
        );
    }

    #[test]
    fn fake_sidecar_with_wrong_instance_or_protocol_is_killed_before_use() {
        for (name, value) in [
            ("FAKE_HANDSHAKE_INSTANCE", "different-instance"),
            ("FAKE_HANDSHAKE_PROTOCOL", "2"),
        ] {
            let mut command = fake_sidecar_command("graceful", "fixture-token", "fixture-instance");
            command.env(name, value);
            let process = spawn_development_command(command, "fixture-token", "fixture-instance")
                .expect("spawn fake sidecar");
            let error = process
                .readiness
                .wait(Duration::from_secs(10))
                .expect_err("mismatched handshake must be rejected");
            assert!(error.contains("did not match this desktop instance"));
            // Killed before the error became visible, not left running until exit.
            assert!(process.child.lock().expect("sidecar child mutex").is_none());
        }
    }

    #[test]
    fn production_development_command_has_exact_bootstrap_contract() {
        let root = project_root();
        let command = development_sidecar_command(&root, "fixture-token", "fixture-instance");
        let args = command
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_eq!(args, ["-m", "sidecar.bootstrap"]);
        assert_eq!(command.get_current_dir(), Some(root.as_path()));
        assert_eq!(
            command_environment(&command, SIDECAR_HOST_ENV).as_deref(),
            Some("127.0.0.1")
        );
        assert_eq!(
            command_environment(&command, SIDECAR_PORT_ENV).as_deref(),
            Some("0")
        );
        assert_eq!(
            command_environment(&command, SIDECAR_AUTH_ENV).as_deref(),
            Some("fixture-token")
        );
        assert_eq!(
            command_environment(&command, SIDECAR_INSTANCE_ENV).as_deref(),
            Some("fixture-instance")
        );
        assert_eq!(
            command_environment(&command, SIDECAR_PROTOCOL_ENV).as_deref(),
            Some("1")
        );
        assert_eq!(
            command_environment(&command, "ULTIMATE_NOVELAI_LAUNCHER_ALLOW_DEV_ORIGINS").as_deref(),
            Some("1")
        );
    }

    #[test]
    fn bundled_sidecar_path_is_where_the_bundle_puts_the_onedir_build() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json parses");
        let bundle = &config["bundle"];
        assert_eq!(
            bundle["resources"]["../build/sidecar/dist/ultimate-novelai-sidecar/"],
            "sidecar/"
        );
        // A onefile externalBin would bring the per-launch unpacking back.
        assert!(bundle.get("externalBin").is_none());
        let executable = Path::new(BUNDLED_SIDECAR);
        assert_eq!(executable.parent(), Some(Path::new("sidecar")));
        assert_eq!(
            executable.file_stem().and_then(|stem| stem.to_str()),
            Some("ultimate-novelai-sidecar")
        );
    }

    #[test]
    fn managed_sidecar_always_uses_a_kernel_assigned_port() {
        assert_eq!(MANAGED_SIDECAR_PORT, "0");
        assert_eq!(DRAIN_TIMEOUT, Duration::from_secs(8));
    }

    #[test]
    fn secure_random_hex_has_the_requested_width() {
        let first = random_hex::<16>().expect("secure random bytes");
        let second = random_hex::<16>().expect("secure random bytes");
        assert_eq!(first.len(), 32);
        assert!(first.chars().all(|character| character.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }
}
