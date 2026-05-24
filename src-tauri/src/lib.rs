use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child as ProcessChild, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServiceConfig {
    id: String,
    name: String,
    path: String,
    command: String,
    url: Option<String>,
    port: Option<u16>,
    auto_start: bool,
    notes: Option<String>,
    #[serde(default)]
    logo_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServiceInput {
    id: Option<String>,
    name: String,
    path: String,
    command: String,
    url: Option<String>,
    port: Option<u16>,
    auto_start: Option<bool>,
    notes: Option<String>,
    logo_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceStatus {
    id: String,
    name: String,
    path: String,
    command: String,
    url: Option<String>,
    port: Option<u16>,
    auto_start: bool,
    notes: Option<String>,
    logo_path: Option<String>,
    resolved_logo_path: Option<String>,
    state: String,
    pid: Option<u32>,
    uptime_seconds: Option<u64>,
    last_exit: Option<String>,
    log_lines: Vec<String>,
    updated_at: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UiState {
    selected_id: Option<String>,
    draft: Option<serde_json::Value>,
    editor_dialog_open: Option<bool>,
    kill_port: Option<String>,
    main_view: Option<String>,
    service_info_customized: Option<serde_json::Value>,
    terminal_by_project: Option<serde_json::Value>,
    terminal_command: Option<String>,
    terminal_entries: Option<serde_json::Value>,
    terminal_open: Option<bool>,
    terminal_pane_height: Option<u16>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandSuggestion {
    name: String,
    command: String,
    source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct KillPortResult {
    port: u16,
    pids: Vec<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalCommandInput {
    command: String,
    cwd: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalCommandResult {
    command: String,
    cwd: String,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    duration_ms: u64,
    timed_out: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalSessionInput {
    project_id: String,
    command: Option<String>,
    cwd: String,
    cols: Option<u16>,
    rows: Option<u16>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalWriteInput {
    project_id: String,
    data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalResizeInput {
    project_id: String,
    cols: u16,
    rows: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalProjectInput {
    project_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalSessionInfo {
    project_id: String,
    session_id: String,
    command: String,
    cwd: String,
    started_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputPayload {
    project_id: String,
    session_id: String,
    output: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitPayload {
    project_id: String,
    session_id: String,
    exit_code: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct DetectedServiceInfo {
    url: Option<String>,
    port: Option<u16>,
}

struct ProcessHandle {
    child: ProcessChild,
    pid: u32,
    started_at: SystemTime,
}

struct RuntimeService {
    config: ServiceConfig,
    process: Option<ProcessHandle>,
    last_exit: Option<String>,
}

struct TerminalSession {
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    master: Box<dyn MasterPty + Send>,
    session_id: String,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
}

struct AppState {
    services: Mutex<HashMap<String, RuntimeService>>,
    config_path: PathBuf,
    logs_dir: PathBuf,
    terminal_sessions: Mutex<HashMap<String, TerminalSession>>,
    ui_state_path: PathBuf,
}

impl RuntimeService {
    fn from_config(config: ServiceConfig) -> Self {
        Self {
            config,
            process: None,
            last_exit: None,
        }
    }
}

impl AppState {
    fn load(config_dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;
        let logs_dir = config_dir.join("logs");
        fs::create_dir_all(&logs_dir).map_err(|error| error.to_string())?;
        let config_path = config_dir.join("services.json");
        let ui_state_path = config_dir.join("ui-state.json");

        let configs = if config_path.exists() {
            let contents = fs::read_to_string(&config_path).map_err(|error| error.to_string())?;
            serde_json::from_str::<Vec<ServiceConfig>>(&contents)
                .map_err(|error| error.to_string())?
        } else {
            Vec::new()
        };

        let services = configs
            .into_iter()
            .map(|config| (config.id.clone(), RuntimeService::from_config(config)))
            .collect();

        Ok(Self {
            services: Mutex::new(services),
            config_path,
            logs_dir,
            terminal_sessions: Mutex::new(HashMap::new()),
            ui_state_path,
        })
    }

    fn auto_start_ids(&self) -> Result<Vec<String>, String> {
        let services = self.services.lock().map_err(|error| error.to_string())?;
        Ok(services
            .values()
            .filter(|service| {
                service.config.auto_start && !service.config.command.trim().is_empty()
            })
            .map(|service| service.config.id.clone())
            .collect())
    }
}

#[tauri::command]
fn list_services(state: State<'_, AppState>) -> Result<Vec<ServiceStatus>, String> {
    let mut services = state.services.lock().map_err(|error| error.to_string())?;
    refresh_processes(&mut services);
    let mut statuses = services
        .values()
        .map(|service| build_status(service, &state.logs_dir))
        .collect::<Vec<_>>();
    statuses.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(statuses)
}

#[tauri::command]
fn load_ui_state(state: State<'_, AppState>) -> Result<UiState, String> {
    if !state.ui_state_path.exists() {
        return Ok(UiState::default());
    }

    let contents = fs::read_to_string(&state.ui_state_path).map_err(|error| error.to_string())?;
    Ok(serde_json::from_str::<UiState>(&contents).unwrap_or_default())
}

#[tauri::command]
fn save_ui_state(state: State<'_, AppState>, ui_state: UiState) -> Result<(), String> {
    if let Some(parent) = state.ui_state_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let contents = serde_json::to_string_pretty(&ui_state).map_err(|error| error.to_string())?;
    fs::write(&state.ui_state_path, contents).map_err(|error| error.to_string())
}

#[tauri::command]
fn upsert_service(
    state: State<'_, AppState>,
    input: ServiceInput,
) -> Result<ServiceStatus, String> {
    let config = normalize_input(input)?;
    let mut services = state.services.lock().map_err(|error| error.to_string())?;
    refresh_processes(&mut services);
    let service_id = config.id.clone();

    {
        let service = services
            .entry(service_id.clone())
            .or_insert_with(|| RuntimeService::from_config(config.clone()));
        service.config = config;
    }

    persist_services(&state, &services)?;

    let service = services
        .get(&service_id)
        .ok_or_else(|| format!("Service not found: {service_id}"))?;
    Ok(build_status(service, &state.logs_dir))
}

#[tauri::command]
fn remove_service(state: State<'_, AppState>, id: String) -> Result<(), String> {
    stop_terminal_session_inner(&state, &id)?;

    let mut services = state.services.lock().map_err(|error| error.to_string())?;
    refresh_processes(&mut services);

    if let Some(mut service) = services.remove(&id) {
        if let Some(mut process) = service.process.take() {
            terminate_process(&mut process.child, process.pid)?;
            let _ = process.child.wait();
        }
    }

    persist_services(&state, &services)
}

#[tauri::command]
fn start_service(state: State<'_, AppState>, id: String) -> Result<ServiceStatus, String> {
    start_service_inner(&state, &id)
}

#[tauri::command]
fn stop_service(state: State<'_, AppState>, id: String) -> Result<ServiceStatus, String> {
    stop_service_inner(&state, &id)
}

#[tauri::command]
fn restart_service(state: State<'_, AppState>, id: String) -> Result<ServiceStatus, String> {
    let _ = stop_service_inner(&state, &id);
    clear_log_file(&state, &id)?;
    start_service_inner(&state, &id)
}

#[tauri::command]
fn open_location(target: String) -> Result<(), String> {
    if target.trim().is_empty() {
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&target)
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &target])
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn clear_service_log(state: State<'_, AppState>, id: String) -> Result<ServiceStatus, String> {
    clear_log_file(&state, &id)?;

    let services = state.services.lock().map_err(|error| error.to_string())?;
    let service = services
        .get(&id)
        .ok_or_else(|| format!("Service not found: {id}"))?;
    Ok(build_status(service, &state.logs_dir))
}

#[tauri::command]
fn kill_port(port: u16) -> Result<KillPortResult, String> {
    if port == 0 {
        return Err("Port must be between 1 and 65535".into());
    }

    let pids = listening_pids_for_port(port)?;
    terminate_pids(&pids)?;

    Ok(KillPortResult { port, pids })
}

#[tauri::command]
fn run_terminal_command(input: TerminalCommandInput) -> Result<TerminalCommandResult, String> {
    let command_text = input.command.trim().to_string();
    if command_text.is_empty() {
        return Err("Terminal command is required".into());
    }

    let cwd = input.cwd.unwrap_or_default().trim().to_string();
    let resolved_cwd = if cwd.is_empty() {
        std::env::current_dir()
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned()
    } else {
        let path = Path::new(&cwd);
        if !path.is_dir() {
            return Err(format!("Terminal path is not a directory: {cwd}"));
        }

        path.to_string_lossy().into_owned()
    };

    let mut command = shell_command(&command_text);
    command
        .current_dir(&resolved_cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let start = Instant::now();
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let pid = child.id();
    let stdout_reader = child
        .stdout
        .take()
        .map(|stdout| thread::spawn(move || read_pipe_to_string(stdout)));
    let stderr_reader = child
        .stderr
        .take()
        .map(|stderr| thread::spawn(move || read_pipe_to_string(stderr)));
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }

        if start.elapsed() >= Duration::from_secs(30) {
            timed_out = true;
            terminate_process(&mut child, pid)?;
            break child.wait().map_err(|error| error.to_string())?;
        }

        thread::sleep(Duration::from_millis(50));
    };

    let stdout = stdout_reader
        .map(|handle| handle.join().unwrap_or_default())
        .unwrap_or_default();
    let stderr = stderr_reader
        .map(|handle| handle.join().unwrap_or_default())
        .unwrap_or_default();

    Ok(TerminalCommandResult {
        command: command_text,
        cwd: resolved_cwd,
        stdout: truncate_terminal_output(stdout),
        stderr: truncate_terminal_output(stderr),
        exit_code: status.code(),
        duration_ms: start.elapsed().as_millis() as u64,
        timed_out,
    })
}

#[tauri::command]
fn start_terminal_session(
    app: AppHandle,
    state: State<'_, AppState>,
    input: TerminalSessionInput,
) -> Result<TerminalSessionInfo, String> {
    let project_id = input.project_id.trim().to_string();
    if project_id.is_empty() {
        return Err("Terminal project is required".into());
    }

    let command_text = input.command.unwrap_or_default().trim().to_string();
    let resolved_cwd = resolve_terminal_cwd(&input.cwd)?;
    let size = terminal_pty_size(input.cols, input.rows);
    let session_id = create_terminal_session_id(&project_id);
    let started_at = now_millis();

    stop_terminal_session_inner(&state, &project_id)?;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(size)
        .map_err(|error| error.to_string())?;
    let mut command = terminal_command_builder(&command_text, &resolved_cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| error.to_string())?;
    let child = Arc::new(Mutex::new(child));
    let writer = Arc::new(Mutex::new(writer));

    spawn_terminal_reader(
        app,
        project_id.clone(),
        session_id.clone(),
        Arc::clone(&child),
        reader,
    );

    let session = TerminalSession {
        child,
        master: pair.master,
        session_id: session_id.clone(),
        writer,
    };

    let mut sessions = state
        .terminal_sessions
        .lock()
        .map_err(|error| error.to_string())?;
    sessions.insert(project_id.clone(), session);

    Ok(TerminalSessionInfo {
        project_id,
        session_id,
        command: command_text,
        cwd: resolved_cwd,
        started_at,
    })
}

#[tauri::command]
fn write_terminal_input(
    state: State<'_, AppState>,
    input: TerminalWriteInput,
) -> Result<(), String> {
    let sessions = state
        .terminal_sessions
        .lock()
        .map_err(|error| error.to_string())?;
    let session = sessions
        .get(input.project_id.trim())
        .ok_or_else(|| format!("Terminal session not found: {}", input.project_id.trim()))?;
    let mut writer = session.writer.lock().map_err(|error| error.to_string())?;
    writer
        .write_all(input.data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn resize_terminal_session(
    state: State<'_, AppState>,
    input: TerminalResizeInput,
) -> Result<(), String> {
    let sessions = state
        .terminal_sessions
        .lock()
        .map_err(|error| error.to_string())?;
    let Some(session) = sessions.get(input.project_id.trim()) else {
        return Ok(());
    };

    session
        .master
        .resize(terminal_pty_size(Some(input.cols), Some(input.rows)))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn stop_terminal_session(
    state: State<'_, AppState>,
    input: TerminalProjectInput,
) -> Result<(), String> {
    stop_terminal_session_inner(&state, input.project_id.trim())
}

#[tauri::command]
fn list_command_suggestions(path: String) -> Result<Vec<CommandSuggestion>, String> {
    let trimmed = path.trim();

    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let workdir = Path::new(trimmed);
    if !workdir.is_dir() {
        return Ok(Vec::new());
    }

    let mut suggestions = package_json_script_suggestions(workdir)?;
    suggestions.sort_by(|left, right| {
        script_priority(&left.name)
            .cmp(&script_priority(&right.name))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(suggestions)
}

#[tauri::command]
fn detect_service_logo(path: String) -> Result<Option<String>, String> {
    let trimmed = path.trim();

    if trimmed.is_empty() {
        return Ok(None);
    }

    Ok(find_service_logo(Path::new(trimmed)))
}

fn normalize_input(input: ServiceInput) -> Result<ServiceConfig, String> {
    let name = input.name.trim().to_string();
    let path = input.path.trim().to_string();
    let command = input.command.trim().to_string();

    if name.is_empty() {
        return Err("Service name is required".into());
    }

    if path.is_empty() {
        return Err("Service path is required".into());
    }

    let id = input
        .id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| create_id(&name));

    Ok(ServiceConfig {
        id,
        name,
        path,
        command,
        url: input.url.and_then(|value| {
            let trimmed = value.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        }),
        port: input.port,
        auto_start: input.auto_start.unwrap_or(false),
        notes: input.notes.and_then(|value| {
            let trimmed = value.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        }),
        logo_path: input.logo_path.and_then(|value| {
            let trimmed = value.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        }),
    })
}

fn clear_log_file(state: &AppState, id: &str) -> Result<(), String> {
    fs::create_dir_all(&state.logs_dir).map_err(|error| error.to_string())?;
    let log_path = state.logs_dir.join(format!("{id}.log"));

    if log_path.exists() {
        OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(log_path)
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn package_json_script_suggestions(workdir: &Path) -> Result<Vec<CommandSuggestion>, String> {
    let package_json_path = workdir.join("package.json");
    if !package_json_path.is_file() {
        return Ok(Vec::new());
    }

    let contents = fs::read_to_string(&package_json_path).map_err(|error| error.to_string())?;
    let package_json =
        serde_json::from_str::<serde_json::Value>(&contents).map_err(|error| error.to_string())?;
    let scripts = match package_json
        .get("scripts")
        .and_then(|value| value.as_object())
    {
        Some(scripts) => scripts,
        None => return Ok(Vec::new()),
    };
    let package_manager = detect_package_manager(workdir, &package_json);

    Ok(scripts
        .keys()
        .map(|name| CommandSuggestion {
            name: name.clone(),
            command: package_script_command(&package_manager, name),
            source: "package.json".into(),
        })
        .collect())
}

fn detect_package_manager(workdir: &Path, package_json: &serde_json::Value) -> String {
    if let Some(package_manager) = package_json
        .get("packageManager")
        .and_then(|value| value.as_str())
    {
        if let Some((name, _version)) = package_manager.split_once('@') {
            return name.to_string();
        }
    }

    if workdir.join("pnpm-lock.yaml").is_file() {
        return "pnpm".into();
    }

    if workdir.join("yarn.lock").is_file() {
        return "yarn".into();
    }

    if workdir.join("bun.lock").is_file() || workdir.join("bun.lockb").is_file() {
        return "bun".into();
    }

    "npm".into()
}

fn package_script_command(package_manager: &str, script_name: &str) -> String {
    match package_manager {
        "pnpm" => format!("pnpm {script_name}"),
        "yarn" => format!("yarn {script_name}"),
        "bun" => format!("bun run {script_name}"),
        _ => {
            if script_name == "start" || script_name == "test" {
                format!("npm {script_name}")
            } else {
                format!("npm run {script_name}")
            }
        }
    }
}

fn script_priority(script_name: &str) -> usize {
    match script_name {
        "dev" => 0,
        "start" => 1,
        "preview" => 2,
        "build" => 3,
        "test" => 4,
        "lint" => 5,
        _ => 10,
    }
}

fn create_id(name: &str) -> String {
    let slug = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");

    let base = if slug.is_empty() { "service" } else { &slug };
    format!("{}-{}", base, now_seconds())
}

fn start_service_inner(state: &AppState, id: &str) -> Result<ServiceStatus, String> {
    let mut services = state.services.lock().map_err(|error| error.to_string())?;
    refresh_processes(&mut services);
    let service = services
        .get_mut(id)
        .ok_or_else(|| format!("Service not found: {id}"))?;

    if service.process.is_some() {
        return Ok(build_status(service, &state.logs_dir));
    }

    if service.config.command.trim().is_empty() {
        return Err("Service command is required to start".into());
    }

    let workdir = Path::new(&service.config.path);
    if !workdir.is_dir() {
        return Err(format!(
            "Service path is not a directory: {}",
            service.config.path
        ));
    }

    fs::create_dir_all(&state.logs_dir).map_err(|error| error.to_string())?;
    let log_path = state.logs_dir.join(format!("{}.log", service.config.id));
    let mut log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| error.to_string())?;
    let stdout = log_file.try_clone().map_err(|error| error.to_string())?;
    writeln!(
        log_file,
        "\n=== vmux start {}: {} ===",
        now_seconds(),
        service.config.command
    )
    .map_err(|error| error.to_string())?;

    let mut command = shell_command(&service.config.command);
    command
        .current_dir(workdir)
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(log_file));

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let child = command.spawn().map_err(|error| error.to_string())?;
    let pid = child.id();
    service.process = Some(ProcessHandle {
        child,
        pid,
        started_at: SystemTime::now(),
    });
    service.last_exit = None;

    Ok(build_status(service, &state.logs_dir))
}

fn stop_service_inner(state: &AppState, id: &str) -> Result<ServiceStatus, String> {
    let mut services = state.services.lock().map_err(|error| error.to_string())?;
    refresh_processes(&mut services);
    let service = services
        .get_mut(id)
        .ok_or_else(|| format!("Service not found: {id}"))?;

    if let Some(mut process) = service.process.take() {
        terminate_process(&mut process.child, process.pid)?;
        let _ = process.child.wait();
        service.last_exit = Some("stopped by Vmux".into());
    }

    Ok(build_status(service, &state.logs_dir))
}

fn shell_command(command: &str) -> Command {
    #[cfg(target_os = "windows")]
    {
        let mut shell = Command::new("cmd");
        shell.args(["/C", command]);
        shell
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut shell = Command::new("sh");
        shell.args(["-lc", command]);
        shell
    }
}

fn read_pipe_to_string<R: Read>(mut reader: R) -> String {
    let mut output = String::new();
    let _ = reader.read_to_string(&mut output);
    output
}

fn truncate_terminal_output(output: String) -> String {
    const MAX_CHARS: usize = 120_000;

    if output.chars().count() <= MAX_CHARS {
        return output;
    }

    let tail = output
        .chars()
        .rev()
        .take(MAX_CHARS)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();

    format!("... output truncated ...\n{tail}")
}

fn resolve_terminal_cwd(cwd: &str) -> Result<String, String> {
    let trimmed = cwd.trim();
    if trimmed.is_empty() {
        return Ok(std::env::current_dir()
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned());
    }

    let path = Path::new(trimmed);
    if !path.is_dir() {
        return Err(format!("Terminal path is not a directory: {trimmed}"));
    }

    Ok(path.to_string_lossy().into_owned())
}

fn terminal_pty_size(cols: Option<u16>, rows: Option<u16>) -> PtySize {
    PtySize {
        cols: cols.unwrap_or(100).clamp(20, 400),
        rows: rows.unwrap_or(30).clamp(6, 120),
        pixel_height: 0,
        pixel_width: 0,
    }
}

fn terminal_command_builder(command_text: &str, cwd: &str) -> CommandBuilder {
    #[cfg(target_os = "windows")]
    {
        let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
        let mut command = CommandBuilder::new(shell);
        if !command_text.is_empty() {
            command.args(["/C", command_text]);
        }
        command.cwd(cwd);
        command
    }

    #[cfg(not(target_os = "windows"))]
    {
        if command_text.is_empty() {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
            let mut command = CommandBuilder::new(shell);
            command.cwd(cwd);
            return command;
        }

        let mut command = CommandBuilder::new("sh");
        command.args(["-lc", command_text]);
        command.cwd(cwd);
        command
    }
}

fn spawn_terminal_reader(
    app: AppHandle,
    project_id: String,
    session_id: String,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    mut reader: Box<dyn Read + Send>,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let output = String::from_utf8_lossy(&buffer[..count]).to_string();
                    let _ = app.emit(
                        "terminal-output",
                        TerminalOutputPayload {
                            output,
                            project_id: project_id.clone(),
                            session_id: session_id.clone(),
                        },
                    );
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(error) => {
                    let _ = app.emit(
                        "terminal-output",
                        TerminalOutputPayload {
                            output: format!("\r\n[terminal read error: {error}]\r\n"),
                            project_id: project_id.clone(),
                            session_id: session_id.clone(),
                        },
                    );
                    break;
                }
            }
        }

        let exit_code = child
            .lock()
            .ok()
            .and_then(|mut child| child.wait().ok())
            .map(|status| status.exit_code());

        if let Some(state) = app.try_state::<AppState>() {
            if let Ok(mut sessions) = state.terminal_sessions.lock() {
                let should_remove = sessions
                    .get(&project_id)
                    .map(|session| session.session_id == session_id)
                    .unwrap_or(false);
                if should_remove {
                    sessions.remove(&project_id);
                }
            }
        }

        let _ = app.emit(
            "terminal-exit",
            TerminalExitPayload {
                exit_code,
                project_id,
                session_id,
            },
        );
    });
}

fn stop_terminal_session_inner(state: &AppState, project_id: &str) -> Result<(), String> {
    let session = {
        let mut sessions = state
            .terminal_sessions
            .lock()
            .map_err(|error| error.to_string())?;
        sessions.remove(project_id)
    };

    if let Some(session) = session {
        let mut child = session.child.lock().map_err(|error| error.to_string())?;
        let _ = child.kill();
    }

    Ok(())
}

fn create_terminal_session_id(project_id: &str) -> String {
    format!("{project_id}-{}", now_millis())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn terminate_process(child: &mut ProcessChild, pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        unsafe {
            libc::killpg(pid as i32, libc::SIGTERM);
        }
        thread::sleep(Duration::from_millis(450));
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none()
        {
            unsafe {
                libc::killpg(pid as i32, libc::SIGKILL);
            }
        }
        return Ok(());
    }

    #[cfg(not(unix))]
    {
        child.kill().map_err(|error| error.to_string())
    }
}

#[cfg(unix)]
fn listening_pids_for_port(port: u16) -> Result<Vec<u32>, String> {
    let output = Command::new("lsof")
        .args(["-nP", "-t", "-sTCP:LISTEN"])
        .arg(format!("-iTCP:{port}"))
        .output()
        .map_err(|error| format!("Failed to inspect port {port}: {error}"))?;

    if !output.status.success() && output.stdout.is_empty() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if error.is_empty() {
            return Ok(Vec::new());
        }

        return Err(error);
    }

    Ok(parse_pid_lines(&String::from_utf8_lossy(&output.stdout)))
}

#[cfg(windows)]
fn listening_pids_for_port(port: u16) -> Result<Vec<u32>, String> {
    let output = Command::new("netstat")
        .args(["-ano", "-p", "tcp"])
        .output()
        .map_err(|error| format!("Failed to inspect port {port}: {error}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(parse_netstat_pids(
        &String::from_utf8_lossy(&output.stdout),
        port,
    ))
}

fn parse_pid_lines(output: &str) -> Vec<u32> {
    let current_pid = std::process::id();
    let mut pids = output
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .filter(|pid| *pid != current_pid)
        .collect::<Vec<_>>();

    pids.sort_unstable();
    pids.dedup();
    pids
}

#[cfg(windows)]
fn parse_netstat_pids(output: &str, port: u16) -> Vec<u32> {
    let needle = format!(":{port}");
    let mut pids = output
        .lines()
        .filter_map(|line| {
            let columns = line.split_whitespace().collect::<Vec<_>>();
            if columns.len() < 5 || !columns[0].eq_ignore_ascii_case("TCP") {
                return None;
            }

            let local_address = columns[1];
            let state = columns[3];
            let pid = columns[4];
            if !state.eq_ignore_ascii_case("LISTENING") || !local_address.ends_with(&needle) {
                return None;
            }

            pid.parse::<u32>().ok()
        })
        .collect::<Vec<_>>();

    pids.sort_unstable();
    pids.dedup();
    pids
}

#[cfg(unix)]
fn terminate_pids(pids: &[u32]) -> Result<(), String> {
    for pid in pids {
        send_signal(*pid, libc::SIGTERM)?;
    }

    thread::sleep(Duration::from_millis(450));

    for pid in pids {
        if process_exists(*pid) {
            send_signal(*pid, libc::SIGKILL)?;
        }
    }

    Ok(())
}

#[cfg(windows)]
fn terminate_pids(pids: &[u32]) -> Result<(), String> {
    for pid in pids {
        let output = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
            .map_err(|error| format!("Failed to terminate PID {pid}: {error}"))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
    }

    Ok(())
}

#[cfg(unix)]
fn send_signal(pid: u32, signal: i32) -> Result<(), String> {
    let result = unsafe { libc::kill(pid as i32, signal) };
    if result == 0 {
        return Ok(());
    }

    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }

    Err(format!("Failed to signal PID {pid}: {error}"))
}

#[cfg(unix)]
fn process_exists(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as i32, 0) };
    if result == 0 {
        return true;
    }

    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn refresh_processes(services: &mut HashMap<String, RuntimeService>) {
    for service in services.values_mut() {
        let exit = if let Some(process) = service.process.as_mut() {
            match process.child.try_wait() {
                Ok(Some(status)) => Some(format!("exited with {status}")),
                Ok(None) => None,
                Err(error) => Some(format!("process check failed: {error}")),
            }
        } else {
            None
        };

        if let Some(exit) = exit {
            service.process = None;
            service.last_exit = Some(exit);
        }
    }
}

fn persist_services(
    state: &AppState,
    services: &HashMap<String, RuntimeService>,
) -> Result<(), String> {
    let mut configs = services
        .values()
        .map(|service| service.config.clone())
        .collect::<Vec<_>>();
    configs.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    let contents = serde_json::to_string_pretty(&configs).map_err(|error| error.to_string())?;
    fs::write(&state.config_path, contents).map_err(|error| error.to_string())
}

fn build_status(service: &RuntimeService, logs_dir: &Path) -> ServiceStatus {
    let pid = service.process.as_ref().map(|process| process.pid);
    let uptime_seconds = service.process.as_ref().and_then(|process| {
        process
            .started_at
            .elapsed()
            .ok()
            .map(|elapsed| elapsed.as_secs())
    });
    let log_lines = read_log_tail(&logs_dir.join(format!("{}.log", service.config.id)), 80);
    let detected = detect_service_info(&log_lines);
    let effective_port = service.config.port.or(detected.port);
    let resolved_logo_path = resolve_logo_path(&service.config);
    let port_ready = effective_port.map(is_port_open).unwrap_or(false);
    let state = match (&service.process, port_ready) {
        (Some(_), true) => "ready",
        (Some(_), false) => "running",
        (None, _) => "stopped",
    }
    .to_string();

    ServiceStatus {
        id: service.config.id.clone(),
        name: service.config.name.clone(),
        path: service.config.path.clone(),
        command: service.config.command.clone(),
        url: effective_url(&service.config, &detected),
        port: effective_port,
        auto_start: service.config.auto_start,
        notes: service.config.notes.clone(),
        logo_path: service.config.logo_path.clone(),
        resolved_logo_path,
        state,
        pid,
        uptime_seconds,
        last_exit: service.last_exit.clone(),
        log_lines,
        updated_at: now_seconds(),
    }
}

fn effective_url(config: &ServiceConfig, detected: &DetectedServiceInfo) -> Option<String> {
    if config.url.is_some() {
        return config.url.clone();
    }

    detected
        .url
        .clone()
        .or_else(|| config.port.map(|port| format!("http://localhost:{port}")))
}

fn resolve_logo_path(config: &ServiceConfig) -> Option<String> {
    config
        .logo_path
        .as_deref()
        .and_then(|logo_path| resolve_manual_logo_path(logo_path, &config.path))
        .or_else(|| find_service_logo(Path::new(&config.path)))
}

fn resolve_manual_logo_path(logo_path: &str, service_path: &str) -> Option<String> {
    let trimmed = logo_path.trim();

    if trimmed.is_empty() {
        return None;
    }

    if is_web_logo_path(trimmed) {
        return Some(trimmed.to_string());
    }

    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Some(path.to_string_lossy().into_owned());
    }

    let workdir = Path::new(service_path);
    Some(workdir.join(path).to_string_lossy().into_owned())
}

fn is_web_logo_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("data:")
        || lower.starts_with("blob:")
        || lower.starts_with("asset:")
        || lower.starts_with("file:")
}

fn find_service_logo(workdir: &Path) -> Option<String> {
    if !workdir.is_dir() {
        return None;
    }

    [
        "public/logo.svg",
        "public/logo.png",
        "public/logo.webp",
        "public/logo.jpg",
        "public/logo.jpeg",
        "public/favicon.svg",
        "public/favicon.png",
        "public/icon.svg",
        "public/icon.png",
        "public/apple-touch-icon.png",
        "src/assets/logo.svg",
        "src/assets/logo.png",
        "src/assets/logo.webp",
        "src/assets/icon.svg",
        "src/assets/icon.png",
        "assets/logo.svg",
        "assets/logo.png",
        "assets/logo.webp",
        "app/icon.svg",
        "app/icon.png",
        "src/app/icon.svg",
        "src/app/icon.png",
        "logo.svg",
        "logo.png",
        "logo.webp",
        "favicon.svg",
        "favicon.png",
        "icon.svg",
        "icon.png",
    ]
    .iter()
    .map(|candidate| workdir.join(candidate))
    .find(|path| path.is_file())
    .map(|path| path.to_string_lossy().into_owned())
}

fn detect_service_info(log_lines: &[String]) -> DetectedServiceInfo {
    let mut best: Option<(usize, String)> = None;

    for line in log_lines.iter().rev() {
        for url in urls_from_line(line) {
            let priority = service_url_priority(line, &url);
            if best
                .as_ref()
                .map_or(true, |(best_priority, _url)| priority < *best_priority)
            {
                best = Some((priority, url));
            }
        }
    }

    let url = best.map(|(_priority, url)| url);
    let port = url.as_deref().and_then(port_from_url);

    DetectedServiceInfo { url, port }
}

fn urls_from_line(line: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let mut offset = 0;

    while offset < line.len() {
        let remainder = &line[offset..];
        let Some(relative_start) = next_url_start(remainder) else {
            break;
        };
        let start = offset + relative_start;
        let url_text = &line[start..];
        let end = url_text
            .find(|character: char| {
                character.is_whitespace()
                    || character == '\u{1b}'
                    || character == '"'
                    || character == '\''
                    || character == '<'
                    || character == '>'
            })
            .unwrap_or(url_text.len());
        let url = url_text[..end]
            .trim_end_matches(|character| matches!(character, ',' | ')' | ']' | ';'))
            .to_string();

        if !url.is_empty() {
            urls.push(url);
        }

        offset = start + end.max(1);
    }

    urls
}

fn next_url_start(text: &str) -> Option<usize> {
    match (text.find("http://"), text.find("https://")) {
        (Some(http), Some(https)) => Some(http.min(https)),
        (Some(http), None) => Some(http),
        (None, Some(https)) => Some(https),
        (None, None) => None,
    }
}

fn service_url_priority(line: &str, url: &str) -> usize {
    let local_line = line.to_lowercase().contains("local:");
    let local_url = is_local_url(url);

    match (local_line, local_url) {
        (true, true) => 0,
        (false, true) => 1,
        (true, false) => 2,
        (false, false) => 3,
    }
}

fn is_local_url(url: &str) -> bool {
    let Some(authority) = url_authority(url) else {
        return false;
    };
    let host = authority
        .strip_prefix("[")
        .and_then(|value| value.split_once(']').map(|(host, _rest)| host))
        .or_else(|| authority.split(':').next())
        .unwrap_or(authority);

    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

fn port_from_url(url: &str) -> Option<u16> {
    let authority = url_authority(url)?;
    let port = if authority.starts_with('[') {
        authority
            .split_once("]:")
            .map(|(_host, port)| port)?
            .split(':')
            .next()
            .unwrap_or("")
    } else {
        authority.rsplit_once(':').map(|(_host, port)| port)?
    };

    port.parse::<u16>().ok()
}

fn url_authority(url: &str) -> Option<&str> {
    let without_scheme = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))?;
    Some(
        without_scheme
            .split(|character| matches!(character, '/' | '?' | '#'))
            .next()
            .unwrap_or(without_scheme),
    )
}

fn is_port_open(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&address, Duration::from_millis(150)).is_ok()
}

fn read_log_tail(path: &Path, max_lines: usize) -> Vec<String> {
    let mut file = match OpenOptions::new().read(true).open(path) {
        Ok(file) => file,
        Err(_) => return Vec::new(),
    };

    let length = match file.metadata() {
        Ok(metadata) => metadata.len(),
        Err(_) => return Vec::new(),
    };
    let start = length.saturating_sub(220_000);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }

    let mut contents = String::new();
    if file.read_to_string(&mut contents).is_err() {
        return Vec::new();
    }

    contents
        .lines()
        .rev()
        .take(max_lines)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(ToOwned::to_owned)
        .collect()
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::{
        detect_service_info, normalize_input, parse_pid_lines, DetectedServiceInfo, ServiceInput,
    };

    #[test]
    fn detects_vite_local_url_from_output() {
        let lines = vec![
            "Port 4025 is in use, trying another one...".to_string(),
            "  VITE v5.4.21  ready in 366 ms".to_string(),
            "  Local:   http://localhost:4026/".to_string(),
            "  Network: http://192.168.100.112:4026/".to_string(),
        ];

        assert_eq!(
            detect_service_info(&lines),
            DetectedServiceInfo {
                url: Some("http://localhost:4026/".into()),
                port: Some(4026),
            }
        );
    }

    #[test]
    fn prefers_recent_local_url() {
        let lines = vec![
            "Local: http://localhost:3000/".to_string(),
            "Local: http://localhost:5173/".to_string(),
        ];

        assert_eq!(
            detect_service_info(&lines),
            DetectedServiceInfo {
                url: Some("http://localhost:5173/".into()),
                port: Some(5173),
            }
        );
    }

    #[test]
    fn parses_unique_port_pids() {
        assert_eq!(
            parse_pid_lines("123\n456\n123\nnot-a-pid\n"),
            vec![123, 456]
        );
    }

    #[test]
    fn normalizes_service_without_command() {
        let config = normalize_input(ServiceInput {
            id: None,
            name: "Docs".into(),
            path: "/tmp".into(),
            command: "   ".into(),
            url: Some(" http://localhost:3000 ".into()),
            port: None,
            auto_start: Some(true),
            notes: None,
            logo_path: None,
        })
        .expect("empty command should be accepted");

        assert_eq!(config.command, "");
        assert_eq!(config.name, "Docs");
        assert_eq!(config.url, Some("http://localhost:3000".into()));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let config_dir = app.path().app_config_dir()?;
            let state = AppState::load(config_dir).map_err(std::io::Error::other)?;
            let auto_start_ids = state.auto_start_ids().map_err(std::io::Error::other)?;
            for id in auto_start_ids {
                let _ = start_service_inner(&state, &id);
            }
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_services,
            load_ui_state,
            save_ui_state,
            list_command_suggestions,
            detect_service_logo,
            clear_service_log,
            kill_port,
            run_terminal_command,
            start_terminal_session,
            write_terminal_input,
            resize_terminal_session,
            stop_terminal_session,
            upsert_service,
            remove_service,
            start_service,
            stop_service,
            restart_service,
            open_location
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
