import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

export type ServiceState = "ready" | "running" | "stopped" | "error";

export type ServiceStatus = {
  id: string;
  name: string;
  path: string;
  command: string;
  url: string | null;
  port: number | null;
  autoStart: boolean;
  notes: string | null;
  logoPath: string | null;
  resolvedLogoPath: string | null;
  state: ServiceState;
  pid: number | null;
  uptimeSeconds: number | null;
  lastExit: string | null;
  logLines: string[];
  updatedAt: number;
};

export type ServiceInput = {
  id?: string | null;
  name: string;
  path: string;
  command: string;
  url?: string | null;
  port?: number | null;
  autoStart?: boolean;
  notes?: string | null;
  logoPath?: string | null;
};

export type CommandSuggestion = {
  name: string;
  command: string;
  source: string;
};

export type KillPortResult = {
  port: number;
  pids: number[];
};

export type TerminalCommandInput = {
  command: string;
  cwd?: string | null;
};

export type TerminalCommandResult = {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
};

export type TerminalSessionInput = {
  projectId: string;
  command?: string | null;
  cwd: string;
  cols?: number | null;
  rows?: number | null;
};

export type TerminalSessionInfo = {
  projectId: string;
  sessionId: string;
  command: string;
  cwd: string;
  startedAt: number;
};

export type TerminalOutputPayload = {
  projectId: string;
  sessionId: string;
  output: string;
};

export type TerminalExitPayload = {
  projectId: string;
  sessionId: string;
  exitCode: number | null;
};

type Action = "start" | "stop" | "restart";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const mockServices: ServiceStatus[] = [
  {
    id: "vmux-preview",
    name: "Vmux preview",
    path: "/Users/mark/Documents/Vmux",
    command: "pnpm dev -- --host 127.0.0.1 --port 1420",
    url: "http://localhost:1420",
    port: 1420,
    autoStart: false,
    notes: "Browser preview mock",
    logoPath: null,
    resolvedLogoPath: "/logo.svg",
    state: "ready",
    pid: 48211,
    uptimeSeconds: 912,
    lastExit: null,
    logLines: [
      "VITE v8 ready in 384 ms",
      "Local: http://localhost:1420/",
      "press h + enter to show help",
    ],
    updatedAt: Date.now(),
  },
];

const mockUiStateKey = "vmux-ui-state";

const mockCommandSuggestions: CommandSuggestion[] = [
  { name: "dev", command: "pnpm dev", source: "package.json" },
  { name: "build", command: "pnpm build", source: "package.json" },
  { name: "preview", command: "pnpm preview", source: "package.json" },
  { name: "tauri", command: "pnpm tauri", source: "package.json" },
  { name: "tauri:dev", command: "pnpm tauri:dev", source: "package.json" },
  { name: "tauri:build", command: "pnpm tauri:build", source: "package.json" },
];

function isTauriRuntime() {
  return Boolean(window.__TAURI_INTERNALS__);
}

export function canSelectServicePath() {
  return isTauriRuntime();
}

function isWebLikePath(path: string) {
  return /^(https?:|data:|blob:|asset:|file:)/i.test(path);
}

function isFileSystemPath(path: string) {
  return path.startsWith("/") || /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
}

export function logoImageSource(logoPath: string | null | undefined) {
  const trimmed = logoPath?.trim();

  if (!trimmed) {
    return null;
  }

  if (isTauriRuntime() && isFileSystemPath(trimmed)) {
    return convertFileSrc(trimmed);
  }

  return trimmed;
}

function delay<T>(value: T) {
  return new Promise<T>((resolve) => window.setTimeout(() => resolve(value), 140));
}

export async function listServices() {
  if (!isTauriRuntime()) {
    return delay([...mockServices]);
  }

  return invoke<ServiceStatus[]>("list_services");
}

export async function loadUiState<T>() {
  if (!isTauriRuntime()) {
    const raw = window.localStorage.getItem(mockUiStateKey);

    if (!raw) {
      return delay(null);
    }

    try {
      return delay(JSON.parse(raw) as T);
    } catch {
      return delay(null);
    }
  }

  return invoke<T>("load_ui_state");
}

export async function saveUiState(uiState: unknown) {
  if (!isTauriRuntime()) {
    window.localStorage.setItem(mockUiStateKey, JSON.stringify(uiState));
    return delay(undefined);
  }

  return invoke<void>("save_ui_state", { uiState });
}

export async function listCommandSuggestions(path: string) {
  if (!path.trim()) {
    return [];
  }

  if (!isTauriRuntime()) {
    return delay([...mockCommandSuggestions]);
  }

  return invoke<CommandSuggestion[]>("list_command_suggestions", { path });
}

export async function detectServiceLogo(path: string) {
  if (!path.trim()) {
    return null;
  }

  if (!isTauriRuntime()) {
    return delay("/logo.svg");
  }

  return invoke<string | null>("detect_service_logo", { path });
}

export async function upsertService(input: ServiceInput) {
  if (!isTauriRuntime()) {
    const next: ServiceStatus = {
      id: input.id || `service-${Date.now()}`,
      name: input.name,
      path: input.path,
      command: input.command,
      url: input.url || null,
      port: input.port || null,
      autoStart: Boolean(input.autoStart),
      notes: input.notes || null,
      logoPath: input.logoPath || null,
      resolvedLogoPath: input.logoPath || "/logo.svg",
      state: "stopped",
      pid: null,
      uptimeSeconds: null,
      lastExit: null,
      logLines: [],
      updatedAt: Date.now(),
    };
    const index = mockServices.findIndex((service) => service.id === next.id);
    if (index >= 0) {
      mockServices[index] = next;
    } else {
      mockServices.unshift(next);
    }
    return delay(next);
  }

  return invoke<ServiceStatus>("upsert_service", { input });
}

export async function removeService(id: string) {
  if (!isTauriRuntime()) {
    const index = mockServices.findIndex((service) => service.id === id);
    if (index >= 0) {
      mockServices.splice(index, 1);
    }
    return delay(undefined);
  }

  return invoke<void>("remove_service", { id });
}

export async function clearServiceLog(id: string) {
  if (!isTauriRuntime()) {
    const service = mockServices.find((item) => item.id === id);
    if (service) {
      service.logLines = [];
      service.updatedAt = Date.now();
    }
    return delay(service);
  }

  return invoke<ServiceStatus>("clear_service_log", { id });
}

export async function killPort(port: number) {
  if (!isTauriRuntime()) {
    const pids: number[] = [];

    for (const service of mockServices) {
      if (service.port === port && service.pid) {
        pids.push(service.pid);
        service.state = "stopped";
        service.pid = null;
        service.uptimeSeconds = null;
        service.lastExit = "stopped by global port kill";
        service.updatedAt = Date.now();
      }
    }

    return delay<KillPortResult>({ port, pids });
  }

  return invoke<KillPortResult>("kill_port", { port });
}

export async function runTerminalCommand(input: TerminalCommandInput) {
  if (!isTauriRuntime()) {
    const cwd = input.cwd?.trim() || "/Users/mark/Documents/Vmux";
    return delay<TerminalCommandResult>({
      command: input.command,
      cwd,
      durationMs: 18,
      exitCode: 0,
      stderr: "",
      stdout: `$ ${input.command}\n${cwd}`,
      timedOut: false,
    });
  }

  return invoke<TerminalCommandResult>("run_terminal_command", { input });
}

export async function startTerminalSession(input: TerminalSessionInput) {
  if (!isTauriRuntime()) {
    return delay<TerminalSessionInfo>({
      command: input.command?.trim() ?? "",
      cwd: input.cwd,
      projectId: input.projectId,
      sessionId: `mock-terminal-${Date.now()}`,
      startedAt: Date.now(),
    });
  }

  return invoke<TerminalSessionInfo>("start_terminal_session", { input });
}

export async function writeTerminalInput(projectId: string, data: string) {
  if (!isTauriRuntime()) {
    return delay(undefined);
  }

  return invoke<void>("write_terminal_input", { input: { data, projectId } });
}

export async function resizeTerminalSession(projectId: string, cols: number, rows: number) {
  if (!isTauriRuntime()) {
    return delay(undefined);
  }

  return invoke<void>("resize_terminal_session", { input: { cols, projectId, rows } });
}

export async function stopTerminalSession(projectId: string) {
  if (!isTauriRuntime()) {
    return delay(undefined);
  }

  return invoke<void>("stop_terminal_session", { input: { projectId } });
}

export async function listenTerminalOutput(callback: (payload: TerminalOutputPayload) => void) {
  if (!isTauriRuntime()) {
    return () => undefined;
  }

  return listen<TerminalOutputPayload>("terminal-output", (event) => callback(event.payload));
}

export async function listenTerminalExit(callback: (payload: TerminalExitPayload) => void) {
  if (!isTauriRuntime()) {
    return () => undefined;
  }

  return listen<TerminalExitPayload>("terminal-exit", (event) => callback(event.payload));
}

export async function serviceAction(action: Action, id: string) {
  if (!isTauriRuntime()) {
    const service = mockServices.find((item) => item.id === id);
    if (service) {
      service.state = action === "stop" ? "stopped" : "running";
      service.pid = action === "stop" ? null : Math.floor(30000 + Math.random() * 10000);
      service.uptimeSeconds = action === "stop" ? null : 0;
      service.updatedAt = Date.now();
      service.logLines = [
        ...(action === "restart" ? [] : service.logLines),
        `[mock] ${action} ${service.name}`,
      ].slice(-30);
    }
    return delay(service);
  }

  const command =
    action === "start"
      ? "start_service"
      : action === "stop"
        ? "stop_service"
        : "restart_service";

  return invoke<ServiceStatus>(command, { id });
}

export async function openLocation(target: string) {
  if (!target) {
    return;
  }

  if (!isTauriRuntime()) {
    window.open(target, "_blank", "noopener,noreferrer");
    return;
  }

  return invoke<void>("open_location", { target });
}

export async function selectServicePath(currentPath?: string) {
  if (!isTauriRuntime()) {
    return null;
  }

  const selected = await openDialog({
    canCreateDirectories: true,
    defaultPath: currentPath?.trim() || undefined,
    directory: true,
    multiple: false,
    title: "Select service path",
  });

  return typeof selected === "string" ? selected : null;
}

export async function selectLogoPath(currentPath?: string, servicePath?: string) {
  if (!isTauriRuntime()) {
    return null;
  }

  const defaultPath = [currentPath, servicePath]
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value && !isWebLikePath(value)));

  const selected = await openDialog({
    defaultPath,
    directory: false,
    filters: [
      {
        extensions: ["avif", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"],
        name: "Images",
      },
    ],
    multiple: false,
    title: "Select service logo",
  });

  return typeof selected === "string" ? selected : null;
}
