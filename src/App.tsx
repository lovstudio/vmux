import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  Activity,
  ArrowRight,
  ChevronDown,
  Check,
  Copy,
  Download,
  Edit3,
  EllipsisVertical,
  Eraser,
  ExternalLink,
  FolderOpen,
  Globe2,
  Image as ImageIcon,
  Info,
  LayoutGrid,
  LoaderCircle,
  Play,
  Plus,
  PowerOff,
  RefreshCcw,
  Save,
  Square,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "./components/ui/button";
import { queryClient, queryKeys } from "./lib/query";
import {
  canSelectServicePath,
  clearServiceLog,
  detectServiceLogo,
  killPort,
  listCommandSuggestions,
  listServices,
  listenTerminalExit,
  listenTerminalOutput,
  loadUiState,
  logoImageSource,
  openLocation,
  removeService,
  resizeTerminalSession,
  selectLogoPath,
  selectServicePath,
  serviceAction,
  saveUiState,
  startTerminalSession,
  writeTerminalInput,
  type CommandSuggestion,
  type KillPortResult,
  type ServiceInput,
  type ServiceState,
  type ServiceStatus,
  type TerminalCommandResult,
  type TerminalSessionInput,
  upsertService,
} from "./lib/vmux-api";

const logoUrl = "/logo.svg";

type Draft = {
  id: string | null;
  name: string;
  path: string;
  command: string;
  url: string;
  port: string;
  autoStart: boolean;
  notes: string;
  logoPath: string;
  resolvedLogoPath: string;
};

type ServiceInfoCustomized = {
  port: boolean;
  url: boolean;
};

type LegacyMainView = "project" | "terminal";

type TerminalEntry = TerminalCommandResult & {
  id: string;
  createdAt: number;
};

type ProjectTerminalState = {
  buffer: string;
  command: string;
  entries: TerminalEntry[];
  running: boolean;
  sessionId: string | null;
};

type TerminalStateByProject = Record<string, ProjectTerminalState>;

type TerminalSize = {
  cols: number;
  rows: number;
};

type PersistedUiState = {
  selectedId: string | null;
  draft: Draft | null;
  editorDialogOpen?: boolean;
  killPort?: string;
  mainView?: LegacyMainView;
  serviceInfoCustomized: ServiceInfoCustomized;
  terminalByProject?: TerminalStateByProject;
  terminalCommand?: string;
  terminalEntries?: TerminalEntry[];
  terminalOpen?: boolean;
  terminalPaneHeight?: number;
};

type SidebarMenuState = {
  serviceId: string;
  x: number;
  y: number;
};

const emptyDraft: Draft = {
  id: null,
  name: "",
  path: "",
  command: "",
  url: "",
  port: "",
  autoStart: false,
  notes: "",
  logoPath: "",
  resolvedLogoPath: "",
};

const terminalBufferLimit = 240_000;
const terminalPaneDefaultHeight = 220;
const terminalPaneMinHeight = 150;
const terminalPaneMaxHeight = 420;
const terminalEntryLimit = 40;
const emptyProjectTerminalState: ProjectTerminalState = {
  buffer: "",
  command: "",
  entries: [],
  running: false,
  sessionId: null,
};

function toDraft(service: ServiceStatus): Draft {
  return {
    id: service.id,
    name: service.name,
    path: service.path,
    command: service.command,
    url: service.url || "",
    port: service.port ? String(service.port) : "",
    autoStart: service.autoStart,
    notes: service.notes || "",
    logoPath: service.logoPath || "",
    resolvedLogoPath: service.resolvedLogoPath || "",
  };
}

function toInput(draft: Draft): ServiceInput {
  const trimmedPort = draft.port.trim();

  return {
    id: draft.id,
    name: draft.name.trim(),
    path: draft.path.trim(),
    command: draft.command.trim(),
    url: draft.url.trim() || null,
    port: trimmedPort ? Number(trimmedPort) : null,
    autoStart: draft.autoStart,
    notes: draft.notes.trim() || null,
    logoPath: draft.logoPath.trim() || null,
  };
}

function normalizePersistedDraft(value: Partial<Draft> | null | undefined): Draft | null {
  if (!value) {
    return null;
  }

  return {
    ...emptyDraft,
    ...value,
    id: value.id ?? null,
    autoStart: Boolean(value.autoStart),
    command: String(value.command ?? ""),
    logoPath: String(value.logoPath ?? ""),
    name: String(value.name ?? ""),
    notes: String(value.notes ?? ""),
    path: String(value.path ?? ""),
    port: value.port == null ? "" : String(value.port),
    resolvedLogoPath: String(value.resolvedLogoPath ?? ""),
    url: String(value.url ?? ""),
  };
}

function normalizeServiceInfoCustomized(
  value: Partial<ServiceInfoCustomized> | null | undefined,
): ServiceInfoCustomized {
  return {
    port: Boolean(value?.port),
    url: Boolean(value?.url),
  };
}

function normalizeTerminalOpen(value: unknown, legacyMainView: unknown) {
  if (typeof value === "boolean") {
    return value;
  }

  if (legacyMainView === "project") {
    return false;
  }

  return true;
}

function clampTerminalPaneHeight(value: number) {
  const viewportMax =
    typeof window === "undefined"
      ? terminalPaneMaxHeight
      : Math.max(terminalPaneMinHeight, Math.min(terminalPaneMaxHeight, window.innerHeight - 320));
  return Math.round(Math.max(terminalPaneMinHeight, Math.min(viewportMax, value)));
}

function normalizeTerminalPaneHeight(value: unknown) {
  return clampTerminalPaneHeight(Number(value) || terminalPaneDefaultHeight);
}

function normalizeTerminalEntries(value: unknown): TerminalEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const item = entry as Partial<TerminalEntry>;
      return {
        command: String(item.command ?? ""),
        createdAt: Number(item.createdAt) || Date.now(),
        cwd: String(item.cwd ?? ""),
        durationMs: Number(item.durationMs) || 0,
        exitCode:
          typeof item.exitCode === "number" && Number.isFinite(item.exitCode)
            ? item.exitCode
            : null,
        id: String(item.id ?? createTerminalEntryId()),
        stderr: String(item.stderr ?? ""),
        stdout: String(item.stdout ?? ""),
        timedOut: Boolean(item.timedOut),
      };
    })
    .filter((entry): entry is TerminalEntry => Boolean(entry?.command))
    .slice(0, terminalEntryLimit);
}

function createTerminalEntryId() {
  return window.crypto?.randomUUID?.() ?? `terminal-${Date.now()}-${Math.random()}`;
}

function normalizeTerminalByProject(value: unknown): TerminalStateByProject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value).reduce<TerminalStateByProject>((terminalByProject, [projectId, state]) => {
    if (!projectId || !state || typeof state !== "object" || Array.isArray(state)) {
      return terminalByProject;
    }

    const item = state as Partial<ProjectTerminalState>;
    const entries = normalizeTerminalEntries(item.entries);
    terminalByProject[projectId] = {
      buffer: normalizeTerminalBuffer(item.buffer ?? legacyTerminalEntriesText(entries)),
      command: String(item.command ?? ""),
      entries,
      running: false,
      sessionId: null,
    };
    return terminalByProject;
  }, {});
}

function normalizeTerminalBuffer(value: unknown) {
  return String(value ?? "").slice(-terminalBufferLimit);
}

function appendTerminalBuffer(buffer: string, output: string) {
  return `${buffer}${output}`.slice(-terminalBufferLimit);
}

const ansiEscapePattern =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const invisibleControlPattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F-\u009F]/g;

function cleanLogText(value: string) {
  return value
    .replace(ansiEscapePattern, "")
    .replace(/\r+\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(invisibleControlPattern, "");
}

function serviceLogText(logLines: string[]) {
  if (logLines.length === 0) {
    return "No logs captured for this project yet.";
  }

  return cleanLogText(logLines.join("\n"));
}

function basenameFromPath(path: string) {
  const normalizedPath = path.trim().replace(/[\\/]+$/, "");
  const segments = normalizedPath.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? "";
}

function initialsFromName(name: string) {
  const parts = name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2);

  if (parts.length === 0) {
    return "VM";
  }

  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("");
}

function isExternalLogoPath(path: string) {
  return /^(https?:|data:|blob:|asset:|file:)/i.test(path);
}

function isAbsoluteLogoPath(path: string) {
  return path.startsWith("/") || /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
}

function resolveDraftLogoPath(logoPath: string, servicePath: string) {
  const trimmedLogoPath = logoPath.trim();
  const trimmedServicePath = servicePath.trim();

  if (!trimmedLogoPath || isExternalLogoPath(trimmedLogoPath) || isAbsoluteLogoPath(trimmedLogoPath)) {
    return trimmedLogoPath;
  }

  if (!trimmedServicePath) {
    return trimmedLogoPath;
  }

  const separator = trimmedServicePath.includes("\\") ? "\\" : "/";
  return `${trimmedServicePath.replace(/[\\/]+$/, "")}${separator}${trimmedLogoPath.replace(
    /^[\\/]+/,
    "",
  )}`;
}

function draftWithPath(current: Draft, path: string): Draft {
  const currentBasename = basenameFromPath(current.path);
  const nextBasename = basenameFromPath(path);
  const shouldDefaultName = !current.name.trim() || current.name === currentBasename;

  return {
    ...current,
    name: shouldDefaultName && nextBasename ? nextBasename : current.name,
    path,
    resolvedLogoPath: path === current.path ? current.resolvedLogoPath : "",
  };
}

function selectElementText(element: HTMLElement | null) {
  if (!element) {
    return;
  }

  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

async function copyText(text: string) {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function formatUptime(seconds: number | null) {
  if (!seconds) {
    return "0s";
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }

  return `${remainingSeconds}s`;
}

function stateLabel(state: ServiceState) {
  if (state === "ready") {
    return "ready";
  }

  if (state === "running") {
    return "running";
  }

  if (state === "error") {
    return "error";
  }

  return "stopped";
}

function stateClass(state: ServiceState) {
  if (state === "ready") {
    return "status-ready";
  }

  if (state === "running") {
    return "status-running";
  }

  if (state === "error") {
    return "status-error";
  }

  return "status-stopped";
}

function parseKillPort(value: string) {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const port = Number(trimmed);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function formatKillPortMessage(result: KillPortResult) {
  if (result.pids.length === 0) {
    return `No listener on :${result.port}`;
  }

  return `Killed ${result.pids.join(", ")}`;
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function terminalEntryStatus(entry: TerminalEntry) {
  if (entry.timedOut) {
    return "timeout";
  }

  if (entry.exitCode === 0) {
    return "exit 0";
  }

  return entry.exitCode == null ? "failed" : `exit ${entry.exitCode}`;
}

function legacyTerminalEntryText(entry: TerminalEntry) {
  return [
    `$ ${entry.command}`,
    entry.cwd ? `cwd: ${entry.cwd}` : "",
    entry.stdout,
    entry.stderr,
    terminalEntryStatus(entry),
  ]
    .filter(Boolean)
    .join("\n");
}

function legacyTerminalEntriesText(entries: TerminalEntry[]) {
  return entries.map(legacyTerminalEntryText).join("\n\n");
}

export function App() {
  return canSelectServicePath() ? <DesktopApp /> : <LandingPage />;
}

function VmuxLogoMark() {
  return (
    <svg viewBox="0 0 512 512" aria-hidden="true" focusable="false">
      <g transform="translate(48 48) scale(0.8125)">
        <rect width="512" height="512" rx="116" fill="#F9F9F7" />
        <rect x="86" y="104" width="150" height="132" rx="28" fill="#CC785C" />
        <rect x="276" y="104" width="150" height="132" rx="28" fill="#181818" />
        <rect x="86" y="276" width="150" height="132" rx="28" fill="#629A90" />
        <rect
          x="276"
          y="276"
          width="150"
          height="132"
          rx="28"
          fill="#F0EEE6"
          stroke="#181818"
          strokeWidth="18"
        />
        <path
          d="M161 236v40m115-106h-40m40 172h-40m115-106v40"
          fill="none"
          stroke="#181818"
          strokeLinecap="round"
          strokeWidth="24"
        />
        <circle cx="256" cy="256" r="34" fill="#CC785C" stroke="#F9F9F7" strokeWidth="16" />
        <path
          d="M122 151h78M122 188h44M312 151h78M312 188h44M122 323h78M122 360h44M312 323h78M312 360h44"
          stroke="#F9F9F7"
          strokeLinecap="round"
          strokeWidth="16"
        />
      </g>
    </svg>
  );
}

function LandingPage() {
  useEffect(() => {
    document.title = "Vmux - One control surface for local dev services";
  }, []);

  return (
    <main className="landing-page">
      <section className="landing-hero">
        <div className="landing-scene" aria-hidden="true">
          <div className="landing-pane landing-pane-primary">
            <div className="landing-pane-head">
              <span className="landing-dot landing-dot-warm" />
              <span>lovscribe</span>
              <strong>ready</strong>
            </div>
            <div className="landing-meta-row">
              <FolderOpen className="h-4 w-4" />
              <span>/Users/mark/lovstudio/coding/lovscribe</span>
            </div>
            <div className="landing-meta-row">
              <Globe2 className="h-4 w-4" />
              <span>http://127.0.0.1:5173/</span>
            </div>
            <div className="landing-terminal">
              <span>VITE v8.0.14 ready in 410 ms</span>
              <span>Local: http://127.0.0.1:5173/</span>
              <span>Watching src-tauri for changes...</span>
            </div>
          </div>

          <div className="landing-pane landing-pane-secondary">
            <div className="landing-pane-head">
              <span className="landing-dot landing-dot-green" />
              <span>web</span>
              <strong>running</strong>
            </div>
            <div className="landing-bar landing-bar-long" />
            <div className="landing-bar" />
            <div className="landing-bar landing-bar-mid" />
          </div>

          <div className="landing-pane landing-pane-tertiary">
            <div className="landing-pane-head">
              <span className="landing-dot" />
              <span>api</span>
              <strong>stopped</strong>
            </div>
            <div className="landing-control-row">
              <span>Start</span>
              <span>Stop</span>
              <span>Restart</span>
            </div>
          </div>

          <div className="landing-rail">
            <span>projects</span>
            <span>ports</span>
            <span>logs</span>
            <span>shell</span>
          </div>
        </div>

        <header className="landing-nav">
          <a className="landing-brand" href="/">
            <VmuxLogoMark />
            <span>Vmux</span>
          </a>
          <nav aria-label="Landing page">
            <a href="#workflow">Workflow</a>
            <a href="#release">Release</a>
            <a href="https://github.com/lovstudio/vmux" rel="noreferrer" target="_blank">
              GitHub
            </a>
          </nav>
        </header>

        <div className="landing-copy">
          <p className="landing-kicker">Local service multiplexing</p>
          <h1>Run every dev server from one quiet desktop surface.</h1>
          <p>
            Vmux keeps project paths, commands, local URLs, ports, process state, and logs in one
            compact control board for people who run many local apps at once.
          </p>
          <div className="landing-actions">
            <a className="landing-button landing-button-primary" href="https://github.com/lovstudio/vmux/releases/latest">
              <Download className="h-4 w-4" />
              Download
            </a>
            <a className="landing-button" href="#workflow">
              See workflow
              <ArrowRight className="h-4 w-4" />
            </a>
          </div>
        </div>
      </section>

      <section id="workflow" className="landing-section">
        <div className="landing-section-heading">
          <p>Operational, not theatrical</p>
          <h2>Built for the repeated motions of local development.</h2>
        </div>
        <div className="landing-feature-grid">
          <article>
            <LayoutGrid className="h-5 w-5" />
            <h3>Project panes</h3>
            <p>Save each service with its working directory, command, URL, port, logo, and notes.</p>
          </article>
          <article>
            <PowerOff className="h-5 w-5" />
            <h3>Process controls</h3>
            <p>Start, stop, restart, and inspect readiness without hunting through terminal tabs.</p>
          </article>
          <article>
            <TerminalSquare className="h-5 w-5" />
            <h3>Readable logs</h3>
            <p>Recent output stays close to the service, with terminal control noise stripped out.</p>
          </article>
        </div>
      </section>

      <section id="release" className="landing-release">
        <div>
          <p className="landing-kicker">Desktop first</p>
          <h2>Designed as a Tauri app, published with a web landing page.</h2>
        </div>
        <a className="landing-button landing-button-primary" href="https://github.com/lovstudio/vmux/releases/latest">
          <Download className="h-4 w-4" />
          Latest build
        </a>
      </section>
    </main>
  );
}

function DesktopApp() {
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [pathSelecting, setPathSelecting] = useState(false);
  const [logoSelecting, setLogoSelecting] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sidebarMenu, setSidebarMenu] = useState<SidebarMenuState | null>(null);
  const [editorDialogOpen, setEditorDialogOpen] = useState(false);
  const editorDialogRef = useRef<HTMLDivElement>(null);
  const [killPortValue, setKillPortValue] = useState("");
  const [killPortMessage, setKillPortMessage] = useState<string | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(true);
  const [terminalPaneHeight, setTerminalPaneHeight] = useState(terminalPaneDefaultHeight);
  const [terminalByProject, setTerminalByProject] = useState<TerminalStateByProject>({});
  const [terminalSizeByProject, setTerminalSizeByProject] = useState<Record<string, TerminalSize>>({});
  const [serviceInfoCustomized, setServiceInfoCustomized] = useState<ServiceInfoCustomized>({
    port: false,
    url: false,
  });
  const [uiStateLoaded, setUiStateLoaded] = useState(false);
  const terminalStartFailedProjectsRef = useRef<Set<string>>(new Set());

  const servicesQuery = useQuery({
    queryKey: queryKeys.services,
    queryFn: listServices,
    refetchInterval: 1800,
  });

  const services = servicesQuery.data ?? [];
  const draftPath = draft.path.trim();
  const commandSuggestionsQuery = useQuery({
    enabled: Boolean(draftPath),
    queryKey: queryKeys.commandSuggestions(draftPath),
    queryFn: () => listCommandSuggestions(draftPath),
    staleTime: 30_000,
  });
  const commandSuggestions = commandSuggestionsQuery.data ?? [];
  const detectedLogoQuery = useQuery({
    enabled: Boolean(draftPath && !draft.logoPath.trim()),
    queryKey: queryKeys.serviceLogo(draftPath),
    queryFn: () => detectServiceLogo(draftPath),
    staleTime: 30_000,
  });
  const draftLogoPath = draft.logoPath.trim()
    ? resolveDraftLogoPath(draft.logoPath, draft.path)
    : (detectedLogoQuery.data ?? draft.resolvedLogoPath);
  const pathBrowseDisabled = pathSelecting || !canSelectServicePath();
  const logoBrowseDisabled = logoSelecting || !canSelectServicePath();
  const selectedService = useMemo(
    () => services.find((service) => service.id === selectedId) ?? services[0] ?? null,
    [selectedId, services],
  );
  const sidebarMenuService = useMemo(
    () => services.find((service) => service.id === sidebarMenu?.serviceId) ?? null,
    [services, sidebarMenu?.serviceId],
  );
  const killPortNumber = parseKillPort(killPortValue);
  const terminalProjectId = selectedService?.id ?? null;
  const terminalState =
    (terminalProjectId ? terminalByProject[terminalProjectId] : null) ?? emptyProjectTerminalState;
  const terminalCwd = selectedService?.path ?? "";
  const terminalSize =
    (terminalProjectId ? terminalSizeByProject[terminalProjectId] : null) ?? { cols: 100, rows: 30 };

  function clearCachedLogs(id: string) {
    queryClient.setQueryData<ServiceStatus[]>(queryKeys.services, (current) =>
      current?.map((service) => (service.id === id ? { ...service, logLines: [] } : service)),
    );
  }

  function loadDraft(nextDraft: Draft) {
    setDraft(nextDraft);
    setServiceInfoCustomized({ port: false, url: false });
  }

  function openCreateDialog() {
    closeSidebarMenu();
    loadDraft(emptyDraft);
    setEditorDialogOpen(true);
  }

  function closeEditorDialog() {
    setEditorDialogOpen(false);
  }

  function sidebarMenuPosition(x: number, y: number) {
    const menuWidth = 228;
    const menuHeight = 348;

    return {
      x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8)),
    };
  }

  function openSidebarMenu(event: MouseEvent, service: ServiceStatus) {
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(service.id);

    const position = sidebarMenuPosition(event.clientX, event.clientY);
    setSidebarMenu({ serviceId: service.id, ...position });
  }

  function openSidebarButtonMenu(event: MouseEvent<HTMLButtonElement>, service: ServiceStatus) {
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(service.id);

    const rect = event.currentTarget.getBoundingClientRect();
    const position = sidebarMenuPosition(rect.right + 4, rect.top);
    setSidebarMenu({ serviceId: service.id, ...position });
  }

  function closeSidebarMenu() {
    setSidebarMenu(null);
  }

  function updateProjectTerminal(
    projectId: string,
    updater: (current: ProjectTerminalState) => ProjectTerminalState,
  ) {
    setTerminalByProject((current) => {
      const nextState = updater(current[projectId] ?? emptyProjectTerminalState);
      return {
        ...current,
        [projectId]: {
          buffer: normalizeTerminalBuffer(nextState.buffer),
          command: nextState.command,
          entries: nextState.entries.slice(0, terminalEntryLimit),
          running: nextState.running,
          sessionId: nextState.sessionId,
        },
      };
    });
  }

  function clearCurrentTerminalEntries() {
    if (!terminalProjectId) {
      return;
    }

    updateProjectTerminal(terminalProjectId, (current) => ({
      ...current,
      buffer: "",
      entries: [],
    }));
  }

  useEffect(() => {
    let cancelled = false;

    loadUiState<PersistedUiState>()
      .then((uiState) => {
        if (cancelled || !uiState) {
          return;
        }

        if ("selectedId" in uiState) {
          setSelectedId(uiState.selectedId ?? null);
        }

        const persistedDraft = normalizePersistedDraft(uiState.draft);
        if (persistedDraft) {
          setDraft(persistedDraft);
        }

        setEditorDialogOpen(Boolean(uiState.editorDialogOpen));
        setKillPortValue(String(uiState.killPort ?? ""));
        setTerminalOpen(normalizeTerminalOpen(uiState.terminalOpen, uiState.mainView));
        setTerminalPaneHeight(normalizeTerminalPaneHeight(uiState.terminalPaneHeight));
        setServiceInfoCustomized(normalizeServiceInfoCustomized(uiState.serviceInfoCustomized));
        const persistedTerminalByProject = normalizeTerminalByProject(uiState.terminalByProject);
        if (Object.keys(persistedTerminalByProject).length > 0) {
          setTerminalByProject(persistedTerminalByProject);
        } else if (uiState.selectedId) {
          const entries = normalizeTerminalEntries(uiState.terminalEntries);
          setTerminalByProject({
            [uiState.selectedId]: {
              buffer: legacyTerminalEntriesText(entries),
              command: String(uiState.terminalCommand ?? ""),
              entries,
              running: false,
              sessionId: null,
            },
          });
        }
      })
      .finally(() => {
        if (!cancelled) {
          setUiStateLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!uiStateLoaded) {
      return;
    }

    const saveHandle = window.setTimeout(() => {
      void saveUiState({
        draft,
        editorDialogOpen,
        killPort: killPortValue,
        selectedId,
        serviceInfoCustomized,
        terminalByProject,
        terminalOpen,
        terminalPaneHeight,
      });
    }, 250);

    return () => window.clearTimeout(saveHandle);
  }, [
    draft,
    editorDialogOpen,
    killPortValue,
    selectedId,
    serviceInfoCustomized,
    terminalByProject,
    terminalOpen,
    terminalPaneHeight,
    uiStateLoaded,
  ]);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;

    listenTerminalOutput((payload) => {
      updateProjectTerminal(payload.projectId, (current) => {
        if (current.sessionId && current.sessionId !== payload.sessionId) {
          return current;
        }

        return {
          ...current,
          buffer: appendTerminalBuffer(current.buffer, payload.output),
          running: true,
          sessionId: current.sessionId ?? payload.sessionId,
        };
      });
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        unlisteners.push(unlisten);
      }
    });

    listenTerminalExit((payload) => {
      updateProjectTerminal(payload.projectId, (current) => {
        if (current.sessionId && current.sessionId !== payload.sessionId) {
          return current;
        }

        const status = payload.exitCode == null ? "closed" : `exit ${payload.exitCode}`;
        return {
          ...current,
          buffer: appendTerminalBuffer(current.buffer, `\r\n[terminal ${status}]\r\n`),
          running: false,
          sessionId: null,
        };
      });
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        unlisteners.push(unlisten);
      }
    });

    return () => {
      cancelled = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (!uiStateLoaded) {
      return;
    }

    if (!selectedId && selectedService) {
      setSelectedId(selectedService.id);
    }
  }, [selectedId, selectedService, uiStateLoaded]);

  useEffect(() => {
    if (!sidebarMenu) {
      return;
    }

    function closeOnPointerDown(event: globalThis.MouseEvent) {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-sidebar-menu]")) {
        return;
      }

      closeSidebarMenu();
    }

    function closeOnKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        closeSidebarMenu();
      }
    }

    window.addEventListener("mousedown", closeOnPointerDown);
    window.addEventListener("resize", closeSidebarMenu);
    window.addEventListener("scroll", closeSidebarMenu, true);
    window.addEventListener("keydown", closeOnKeyDown);

    return () => {
      window.removeEventListener("mousedown", closeOnPointerDown);
      window.removeEventListener("resize", closeSidebarMenu);
      window.removeEventListener("scroll", closeSidebarMenu, true);
      window.removeEventListener("keydown", closeOnKeyDown);
    };
  }, [sidebarMenu]);

  useEffect(() => {
    if (sidebarMenu && !sidebarMenuService) {
      closeSidebarMenu();
    }
  }, [sidebarMenu, sidebarMenuService]);

  useEffect(() => {
    if (!editorDialogOpen) {
      return;
    }

    editorDialogRef.current?.focus();

    function closeOnKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setEditorDialogOpen(false);
      }
    }

    window.addEventListener("keydown", closeOnKeyDown);

    return () => {
      window.removeEventListener("keydown", closeOnKeyDown);
    };
  }, [editorDialogOpen]);

  useEffect(() => {
    if (!draft.id) {
      return;
    }

    const service = services.find((item) => item.id === draft.id);
    if (!service) {
      return;
    }

    const detectedUrl = service.url || "";
    const detectedPort = service.port ? String(service.port) : "";
    if (!detectedUrl && !detectedPort) {
      return;
    }

    setDraft((current) => {
      if (current.id !== service.id) {
        return current;
      }

      const nextUrl = !serviceInfoCustomized.url && detectedUrl ? detectedUrl : current.url;
      const nextPort =
        !serviceInfoCustomized.port && detectedPort ? detectedPort : current.port;

      if (nextUrl === current.url && nextPort === current.port) {
        return current;
      }

      return {
        ...current,
        port: nextPort,
        url: nextUrl,
      };
    });
  }, [draft.id, serviceInfoCustomized.port, serviceInfoCustomized.url, services]);

  const upsertMutation = useMutation({
    mutationFn: upsertService,
    onSuccess: (service) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.services });
      setSelectedId(service.id);
      loadDraft(toDraft(service));
      setEditorDialogOpen(false);
    },
  });

  const removeMutation = useMutation({
    mutationFn: removeService,
    onSuccess: (_result, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.services });
      loadDraft(emptyDraft);
      setSelectedId(null);
      setTerminalByProject((current) => {
        const { [id]: _removedProject, ...remainingProjects } = current;
        return remainingProjects;
      });
      setEditorDialogOpen(false);
    },
  });

  const actionMutation = useMutation({
    mutationFn: ({ action, id }: { action: "start" | "stop" | "restart"; id: string }) =>
      serviceAction(action, id),
    onMutate: ({ action, id }) => {
      if (action === "restart") {
        clearCachedLogs(id);
      }
    },
    onSuccess: (service) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.services });
      setSelectedId(service?.id ?? selectedId);
    },
  });

  const clearLogMutation = useMutation({
    mutationFn: clearServiceLog,
    onMutate: clearCachedLogs,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.services });
    },
  });

  const killPortMutation = useMutation({
    mutationFn: killPort,
    onError: (error) => {
      setKillPortMessage(formatErrorMessage(error));
    },
    onSuccess: (result) => {
      setKillPortMessage(formatKillPortMessage(result));
      queryClient.invalidateQueries({ queryKey: queryKeys.services });
    },
  });

  const terminalStartMutation = useMutation({
    mutationFn: startTerminalSession,
    onMutate: (input: TerminalSessionInput) => {
      terminalStartFailedProjectsRef.current.delete(input.projectId);
      updateProjectTerminal(input.projectId, (current) => ({
        ...current,
        buffer: appendTerminalBuffer(
          current.buffer,
          `\r\n=== vmux terminal start: ${input.command?.trim() || "shell"} ===\r\n`,
        ),
        command: input.command?.trim() ?? current.command,
        running: true,
        sessionId: null,
      }));
    },
    onError: (error, input) => {
      terminalStartFailedProjectsRef.current.add(input.projectId);
      updateProjectTerminal(input.projectId, (current) => ({
        ...current,
        buffer: appendTerminalBuffer(current.buffer, `\r\n[terminal start error: ${formatErrorMessage(error)}]\r\n`),
        running: false,
        sessionId: null,
      }));
    },
    onSuccess: (session) => {
      terminalStartFailedProjectsRef.current.delete(session.projectId);
      updateProjectTerminal(session.projectId, (current) => ({
        ...current,
        command: session.command,
        running: true,
        sessionId: session.sessionId,
      }));
    },
  });

  useEffect(() => {
    if (
      !terminalOpen ||
      !selectedService ||
      terminalState.running ||
      terminalStartMutation.isPending ||
      terminalStartFailedProjectsRef.current.has(selectedService.id)
    ) {
      return;
    }

    terminalStartMutation.mutate({
      cols: terminalSize.cols,
      command: "",
      cwd: selectedService.path,
      projectId: selectedService.id,
      rows: terminalSize.rows,
    });
  }, [
    selectedService,
    terminalSize.cols,
    terminalSize.rows,
    terminalStartMutation,
    terminalOpen,
    terminalState.running,
  ]);

  const stats = useMemo(() => {
    const running = services.filter(
      (service) => service.state === "running" || service.state === "ready",
    ).length;
    const ready = services.filter((service) => service.state === "ready").length;
    return { running, ready, total: services.length };
  }, [services]);

  function submitDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    upsertMutation.mutate(toInput(draft));
  }

  function submitKillPort(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!killPortNumber) {
      setKillPortMessage("Enter a valid port");
      return;
    }

    if (!window.confirm(`Kill the process listening on port ${killPortNumber}?`)) {
      return;
    }

    setKillPortMessage(null);
    killPortMutation.mutate(killPortNumber);
  }

  function writeCurrentTerminalInput(data: string) {
    if (!terminalProjectId || !terminalState.running) {
      return;
    }

    void writeTerminalInput(terminalProjectId, data).catch((error) => {
      updateProjectTerminal(terminalProjectId, (current) => ({
        ...current,
        buffer: appendTerminalBuffer(current.buffer, `\r\n[terminal input error: ${formatErrorMessage(error)}]\r\n`),
        running: false,
        sessionId: null,
      }));
    });
  }

  function resizeCurrentTerminal(size: TerminalSize) {
    if (!terminalProjectId) {
      return;
    }

    setTerminalSizeByProject((current) => ({
      ...current,
      [terminalProjectId]: size,
    }));

    if (terminalState.running) {
      void resizeTerminalSession(terminalProjectId, size.cols, size.rows);
    }
  }

  function resizeTerminalPane(height: number) {
    setTerminalPaneHeight(clampTerminalPaneHeight(height));
  }

  function updatePath(path: string) {
    setDraft((current) => draftWithPath(current, path));
  }

  async function choosePath() {
    setPathSelecting(true);

    try {
      const path = await selectServicePath(draft.path);
      if (path) {
        updatePath(path);
      }
    } finally {
      setPathSelecting(false);
    }
  }

  async function chooseLogo() {
    setLogoSelecting(true);

    try {
      const path = await selectLogoPath(draft.logoPath, draft.path);
      if (path) {
        setDraft((current) => ({ ...current, logoPath: path, resolvedLogoPath: path }));
      }
    } finally {
      setLogoSelecting(false);
    }
  }

  function renderEditorForm({
    idPrefix,
    onCancel,
  }: {
    idPrefix: string;
    onCancel: () => void;
  }) {
    return (
      <form className="space-y-4" onSubmit={submitDraft}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <ServiceLogo
              logoPath={draftLogoPath}
              name={draft.name || basenameFromPath(draft.path) || "Vmux"}
              size="lg"
            />
            <div className="min-w-0">
              <h2 className="truncate font-serif text-xl font-semibold" id={`${idPrefix}-editor-title`}>
                {draft.id ? "Edit project" : "New project"}
              </h2>
              <p className="truncate text-sm text-muted-foreground">
                {draft.id ? draft.id : "manual project"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {draft.id ? (
              <Button
                disabled={removeMutation.isPending}
                onClick={() => removeMutation.mutate(draft.id!)}
                size="icon"
                title="Remove project"
                variant="ghost"
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            ) : null}
            <Button onClick={onCancel} size="icon" title="Close dialog" variant="ghost">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <PathField
          browseDisabled={pathBrowseDisabled}
          inputId={`${idPrefix}-service-path`}
          label="Path"
          onBrowse={choosePath}
          onChange={updatePath}
          placeholder="/Users/mark/Documents/project"
          value={draft.path}
        />
        <Field
          label="Name"
          onChange={(name) => setDraft((current) => ({ ...current, name }))}
          placeholder={basenameFromPath(draft.path) || "Next.js admin"}
          value={draft.name}
        />
        <LogoField
          browseDisabled={logoBrowseDisabled}
          detectedLogoPath={draftLogoPath}
          inputId={`${idPrefix}-service-logo`}
          label="Logo"
          loading={detectedLogoQuery.isFetching}
          onBrowse={chooseLogo}
          onChange={(logoPath) =>
            setDraft((current) => ({
              ...current,
              logoPath,
              resolvedLogoPath: logoPath.trim() ? current.resolvedLogoPath : "",
            }))
          }
          onClear={() => setDraft((current) => ({ ...current, logoPath: "", resolvedLogoPath: "" }))}
          value={draft.logoPath}
        />
        <CommandField
          inputId={`${idPrefix}-service-command`}
          label="Command"
          loading={commandSuggestionsQuery.isFetching}
          onChange={(command) => setDraft((current) => ({ ...current, command }))}
          placeholder={commandSuggestions[0]?.command ?? "pnpm dev -- --port 3000"}
          suggestions={commandSuggestions}
          value={draft.command}
        />
        <div className="grid grid-cols-[1fr_96px] gap-3">
          <Field
            label="URL"
            onChange={(url) => {
              setServiceInfoCustomized((current) => ({ ...current, url: true }));
              setDraft((current) => ({ ...current, url }));
            }}
            placeholder="http://localhost:3000"
            value={draft.url}
          />
          <Field
            label="Port"
            onChange={(port) => {
              setServiceInfoCustomized((current) => ({ ...current, port: true }));
              setDraft((current) => ({ ...current, port }));
            }}
            placeholder="3000"
            value={draft.port}
          />
        </div>

        <label className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-sm">
          <span>Auto start</span>
          <input
            checked={draft.autoStart}
            className="h-4 w-4 accent-[var(--primary)]"
            onChange={(event) =>
              setDraft((current) => ({ ...current, autoStart: event.target.checked }))
            }
            type="checkbox"
          />
        </label>

        <Field
          label="Notes"
          onChange={(notes) => setDraft((current) => ({ ...current, notes }))}
          placeholder="api + web shell"
          value={draft.notes}
        />

        <div className="flex gap-2">
          <Button
            className="flex-1"
            disabled={
              upsertMutation.isPending ||
              !draft.name.trim() ||
              !draft.path.trim() ||
              !draft.command.trim()
            }
            type="submit"
            variant="primary"
          >
            {upsertMutation.isPending ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {upsertMutation.isPending ? "Saving" : "Save"}
          </Button>
          <Button onClick={onCancel} variant="secondary">
            <X className="h-4 w-4" />
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="flex h-[76px] items-center justify-between border-b border-border px-5">
        <div className="flex min-w-0 items-center gap-3">
          <img alt="" className="h-10 w-10 shrink-0" src={logoUrl} />
          <div className="min-w-0">
            <h1 className="truncate font-serif text-2xl font-semibold">Vmux</h1>
            <p className="truncate text-sm text-muted-foreground">
              {stats.running} running / {stats.ready} ready / {stats.total} total
            </p>
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <form
            className="flex items-center gap-1 rounded-md border border-border bg-card px-1.5 py-1"
            onSubmit={submitKillPort}
          >
            <label className="sr-only" htmlFor="global-kill-port">
              Port to kill
            </label>
            <input
              className="h-7 w-20 rounded border border-input bg-background px-2 font-mono text-xs text-foreground outline-none transition placeholder:text-muted-foreground/70 focus:border-primary focus:ring-2 focus:ring-ring/20"
              id="global-kill-port"
              inputMode="numeric"
              onChange={(event) => {
                setKillPortMessage(null);
                setKillPortValue(event.target.value.replace(/\D/g, "").slice(0, 5));
              }}
              pattern="[0-9]*"
              placeholder="Port"
              title={killPortMessage ?? "Kill process listening on port"}
              value={killPortValue}
            />
            <Button
              disabled={!killPortNumber || killPortMutation.isPending}
              size="sm"
              title="Kill process listening on port"
              type="submit"
              variant="danger"
            >
              {killPortMutation.isPending ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <PowerOff className="h-3.5 w-3.5" />
              )}
              Kill
            </Button>
          </form>
          {killPortMessage ? (
            <span className="max-w-[160px] truncate text-xs text-muted-foreground" title={killPortMessage}>
              {killPortMessage}
            </span>
          ) : null}
          <Button onClick={openCreateDialog} variant="primary">
            <Plus className="h-4 w-4" />
            Add
          </Button>
        </div>
      </header>

      <div className="app-shell">
        <aside className="service-sidebar border-r border-border bg-secondary/60 p-3">
          <div className="mb-3 flex items-center gap-2 px-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            <LayoutGrid className="h-4 w-4" />
            Projects
          </div>
          <div className="space-y-1">
            {services.map((service) => (
              <div className="group relative" key={service.id}>
                <button
                  className={`grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-3 py-2 pr-10 text-left text-sm transition hover:bg-card ${
                    selectedService?.id === service.id ? "bg-card shadow-sm" : ""
                  }`}
                  onClick={() => setSelectedId(service.id)}
                  onContextMenu={(event) => openSidebarMenu(event, service)}
                  type="button"
                >
                  <ServiceLogo logoPath={service.resolvedLogoPath} name={service.name} size="sm" />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{service.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {service.port ? `:${service.port}` : service.url || "no address"}
                    </span>
                  </span>
                  <span className={`status-pill ${stateClass(service.state)}`}>
                    <Activity className="h-3 w-3" />
                  </span>
                </button>
                <button
                  aria-label={`${service.name} actions`}
                  className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring/25 group-hover:opacity-100"
                  onClick={(event) => openSidebarButtonMenu(event, service)}
                  onContextMenu={(event) => openSidebarMenu(event, service)}
                  title="Project actions"
                  type="button"
                >
                  <EllipsisVertical className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
          {sidebarMenu && sidebarMenuService ? (
            <ServiceContextMenu
              actionPending={
                actionMutation.isPending && actionMutation.variables?.id === sidebarMenuService.id
              }
              logClearPending={
                clearLogMutation.isPending && clearLogMutation.variables === sidebarMenuService.id
              }
              onAction={(action) => {
                actionMutation.mutate({ action, id: sidebarMenuService.id });
                closeSidebarMenu();
              }}
              onClearLogs={() => {
                clearLogMutation.mutate(sidebarMenuService.id);
                closeSidebarMenu();
              }}
              onClose={closeSidebarMenu}
              onEdit={() => {
                setSelectedId(sidebarMenuService.id);
                loadDraft(toDraft(sidebarMenuService));
                setEditorDialogOpen(true);
                closeSidebarMenu();
              }}
              onOpen={openLocation}
              onRemove={() => {
                removeMutation.mutate(sidebarMenuService.id);
                closeSidebarMenu();
              }}
              position={sidebarMenu}
              removePending={removeMutation.isPending}
              service={sidebarMenuService}
            />
          ) : null}
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col bg-background p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <LayoutGrid className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate text-sm font-medium">
                {selectedService?.name || "No project"}
              </span>
            </div>
            <Button
              aria-expanded={terminalOpen}
              className="border-border"
              disabled={!selectedService}
              onClick={() => setTerminalOpen((open) => !open)}
              size="sm"
              variant="secondary"
            >
              <TerminalSquare className="h-4 w-4" />
              Terminal
              <ChevronDown className={`h-4 w-4 transition ${terminalOpen ? "rotate-180" : ""}`} />
            </Button>
          </div>

          {!selectedService ? (
            <div className="flex min-h-[480px] items-center justify-center border border-dashed border-border bg-card p-8 text-center">
              <div>
                <TerminalSquare className="mx-auto mb-3 h-9 w-9 text-muted-foreground" />
                <h2 className="font-serif text-2xl">No projects</h2>
                <p className="mt-1 text-sm text-muted-foreground">Create the first project.</p>
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <div className="project-grid min-h-0 flex-1">
                <ProjectPanel
                  actionPending={
                    actionMutation.isPending && actionMutation.variables?.id === selectedService.id
                  }
                  logClearPending={
                    clearLogMutation.isPending && clearLogMutation.variables === selectedService.id
                  }
                  onAction={(action) => actionMutation.mutate({ action, id: selectedService.id })}
                  onClearLogs={() => clearLogMutation.mutate(selectedService.id)}
                  onEdit={() => {
                    setSelectedId(selectedService.id);
                    loadDraft(toDraft(selectedService));
                    setEditorDialogOpen(true);
                  }}
                  onOpen={openLocation}
                  selected
                  service={selectedService}
                />
              </div>
              {terminalOpen ? (
                <TerminalPanel
                  buffer={terminalState.buffer}
                  cwd={terminalCwd}
                  height={terminalPaneHeight}
                  onClear={clearCurrentTerminalEntries}
                  onCopyAll={() => copyText(terminalState.buffer)}
                  onInput={writeCurrentTerminalInput}
                  onResize={resizeCurrentTerminal}
                  onResizePane={resizeTerminalPane}
                  projectName={selectedService.name}
                  running={
                    terminalState.running ||
                    (terminalStartMutation.isPending &&
                      terminalStartMutation.variables?.projectId === terminalProjectId)
                  }
                />
              ) : null}
            </div>
          )}
        </section>
      </div>

      {editorDialogOpen ? (
        <div
          aria-labelledby="dialog-editor-title"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/35 p-4 backdrop-blur-sm"
          onMouseDown={closeEditorDialog}
          role="dialog"
        >
          <div
            className="max-h-[calc(100vh-32px)] w-full max-w-[680px] overflow-auto rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-2xl"
            onMouseDown={(event) => event.stopPropagation()}
            ref={editorDialogRef}
            tabIndex={-1}
          >
            {renderEditorForm({ idPrefix: "dialog", onCancel: closeEditorDialog })}
          </div>
        </div>
      ) : null}
    </main>
  );
}

type ProjectPanelProps = {
  service: ServiceStatus;
  selected: boolean;
  actionPending: boolean;
  logClearPending: boolean;
  onAction: (action: "start" | "stop" | "restart") => void;
  onClearLogs: () => void;
  onEdit: () => void;
  onOpen: (target: string) => void;
};

type ServiceContextMenuProps = {
  service: ServiceStatus;
  position: SidebarMenuState;
  actionPending: boolean;
  logClearPending: boolean;
  removePending: boolean;
  onAction: (action: "start" | "stop" | "restart") => void;
  onClearLogs: () => void;
  onClose: () => void;
  onEdit: () => void;
  onOpen: (target: string) => void;
  onRemove: () => void;
};

function ServiceContextMenu({
  actionPending,
  logClearPending,
  onAction,
  onClearLogs,
  onClose,
  onEdit,
  onOpen,
  onRemove,
  position,
  removePending,
  service,
}: ServiceContextMenuProps) {
  const isRunning = service.state === "ready" || service.state === "running";

  return (
    <div
      className="fixed z-50 w-[228px] rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-xl"
      data-sidebar-menu
      onContextMenu={(event) => event.preventDefault()}
      role="menu"
      style={{ left: position.x, top: position.y }}
    >
      <div className="px-2 py-1.5">
        <div className="truncate text-xs font-semibold text-foreground">{service.name}</div>
        <div className="truncate text-[11px] text-muted-foreground">
          {service.port ? `:${service.port}` : service.url || service.state}
        </div>
      </div>
      <MenuItem icon={<Info className="h-4 w-4" />} label="View details" onClick={onEdit} />
      <MenuItem
        disabled={!service.path}
        icon={<FolderOpen className="h-4 w-4" />}
        label="Open folder"
        onClick={() => {
          onOpen(service.path);
          onClose();
        }}
      />
      <MenuItem
        disabled={!service.url}
        icon={<Globe2 className="h-4 w-4" />}
        label="Open URL"
        onClick={() => {
          if (service.url) {
            onOpen(service.url);
          }
          onClose();
        }}
      />
      <div className="my-1 h-px bg-border" />
      <MenuItem
        disabled={isRunning || actionPending}
        icon={<Play className="h-4 w-4" />}
        label="Start"
        onClick={() => onAction("start")}
      />
      <MenuItem
        disabled={!isRunning || actionPending}
        icon={<Square className="h-4 w-4" />}
        label="Stop"
        onClick={() => onAction("stop")}
      />
      <MenuItem
        disabled={actionPending}
        icon={<RefreshCcw className="h-4 w-4" />}
        label="Restart"
        onClick={() => onAction("restart")}
      />
      <MenuItem
        disabled={logClearPending}
        icon={<Eraser className="h-4 w-4" />}
        label="Clear logs"
        onClick={onClearLogs}
      />
      <div className="my-1 h-px bg-border" />
      <MenuItem
        danger
        disabled={removePending}
        icon={<Trash2 className="h-4 w-4" />}
        label="Remove"
        onClick={onRemove}
      />
    </div>
  );
}

type MenuItemProps = {
  danger?: boolean;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
};

function MenuItem({ danger = false, disabled = false, icon, label, onClick }: MenuItemProps) {
  return (
    <button
      className={`flex h-8 w-full items-center gap-2 rounded px-2 text-left transition hover:bg-muted focus:bg-muted focus:outline-none disabled:pointer-events-none disabled:opacity-45 ${
        danger ? "text-destructive" : "text-popover-foreground"
      }`}
      disabled={disabled}
      onClick={onClick}
      role="menuitem"
      type="button"
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

type TerminalPanelProps = {
  buffer: string;
  cwd: string;
  height: number;
  projectName: string;
  running: boolean;
  onClear: () => void;
  onCopyAll: () => void;
  onInput: (data: string) => void;
  onResize: (size: TerminalSize) => void;
  onResizePane: (height: number) => void;
};

function TerminalPanel({
  buffer,
  cwd,
  height,
  onClear,
  onCopyAll,
  onInput,
  onResize,
  onResizePane,
  projectName,
  running,
}: TerminalPanelProps) {
  const terminalFrameRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const renderedBufferRef = useRef("");
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const runningRef = useRef(running);

  function focusTerminalNow() {
    terminalRef.current?.focus();
    const helperTextarea = terminalFrameRef.current?.querySelector(
      ".xterm-helper-textarea",
    ) as HTMLTextAreaElement | null;
    helperTextarea?.focus({ preventScroll: true });
  }

  function focusTerminalSoon() {
    window.requestAnimationFrame(() => {
      focusTerminalNow();
      window.setTimeout(focusTerminalNow, 30);
    });
  }

  function fitTerminalSoon() {
    window.requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      const terminal = terminalRef.current;
      if (terminal) {
        onResizeRef.current({ cols: terminal.cols, rows: terminal.rows });
      }
    });
  }

  function startPaneResize(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    function handlePointerMove(moveEvent: globalThis.PointerEvent) {
      onResizePane(clampTerminalPaneHeight(startHeight + startY - moveEvent.clientY));
    }

    function handlePointerUp() {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      fitTerminalSoon();
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  function isEditableOutsideTerminal(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    if (target.closest(".xterm")) {
      return false;
    }

    return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
  }

  function keyEventToTerminalData(event: globalThis.KeyboardEvent) {
    if (event.metaKey || event.isComposing) {
      return null;
    }

    if (event.ctrlKey && !event.altKey && event.key.length === 1) {
      const key = event.key.toUpperCase();
      if (key >= "A" && key <= "Z") {
        return String.fromCharCode(key.charCodeAt(0) - 64);
      }

      if (event.key === " ") return "\x00";
      if (event.key === "[") return "\x1b";
      if (event.key === "\\") return "\x1c";
      if (event.key === "]") return "\x1d";
      if (event.key === "^") return "\x1e";
      if (event.key === "_") return "\x1f";
    }

    const specialKeys: Record<string, string> = {
      ArrowDown: "\x1b[B",
      ArrowLeft: "\x1b[D",
      ArrowRight: "\x1b[C",
      ArrowUp: "\x1b[A",
      Backspace: "\x7f",
      Delete: "\x1b[3~",
      End: "\x1b[F",
      Enter: "\r",
      Escape: "\x1b",
      Home: "\x1b[H",
      PageDown: "\x1b[6~",
      PageUp: "\x1b[5~",
      Tab: "\t",
    };
    const specialKey = specialKeys[event.key];
    if (specialKey) {
      return specialKey;
    }

    if (event.key.length === 1 && !event.ctrlKey) {
      return event.altKey ? `\x1b${event.key}` : event.key;
    }

    return null;
  }

  useEffect(() => {
    onInputRef.current = onInput;
    onResizeRef.current = onResize;
    runningRef.current = running;
  }, [onInput, onResize, running]);

  useEffect(() => {
    fitTerminalSoon();
  }, [height]);

  useEffect(() => {
    const frame = terminalFrameRef.current;
    if (!frame) {
      return;
    }

    const terminal = new XTerm({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      fontFamily: "var(--font-family-mono)",
      fontSize: 12,
      lineHeight: 1.35,
      scrollback: 6000,
      theme: {
        background: "#111110",
        black: "#111110",
        blue: "#5f8fb8",
        brightBlack: "#77736b",
        brightBlue: "#7da9cf",
        brightCyan: "#77b8ae",
        brightGreen: "#82b894",
        brightMagenta: "#c296c7",
        brightRed: "#d98a74",
        brightWhite: "#fffdfa",
        brightYellow: "#d7b56d",
        cursor: "#fffdfa",
        cyan: "#5f9f97",
        foreground: "#f7f1e8",
        green: "#6fa67c",
        magenta: "#a984ae",
        red: "#cc785c",
        selectionBackground: "#cc785c55",
        white: "#e7dfd2",
        yellow: "#c99b4f",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(frame);
    fitAddon.fit();
    terminal.write(buffer);
    renderedBufferRef.current = buffer;

    const dataDisposable = terminal.onData((data) => {
      if (runningRef.current) {
        onInputRef.current(data);
      }
    });

    function handleDocumentKeyDown(event: globalThis.KeyboardEvent) {
      if (!runningRef.current || event.defaultPrevented || isEditableOutsideTerminal(event.target)) {
        return;
      }

      const data = keyEventToTerminalData(event);
      if (!data) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      focusTerminalSoon();
      onInputRef.current(data);
    }

    function handleDocumentPaste(event: ClipboardEvent) {
      if (!runningRef.current || event.defaultPrevented || isEditableOutsideTerminal(event.target)) {
        return;
      }

      const text = event.clipboardData?.getData("text");
      if (!text) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      focusTerminalSoon();
      onInputRef.current(text);
    }

    function fitTerminal() {
      fitAddon.fit();
      onResizeRef.current({ cols: terminal.cols, rows: terminal.rows });
    }

    fitTerminal();
    window.addEventListener("resize", fitTerminal);
    document.addEventListener("keydown", handleDocumentKeyDown, true);
    document.addEventListener("paste", handleDocumentPaste, true);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    focusTerminalSoon();

    return () => {
      window.removeEventListener("resize", fitTerminal);
      document.removeEventListener("keydown", handleDocumentKeyDown, true);
      document.removeEventListener("paste", handleDocumentPaste, true);
      dataDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      renderedBufferRef.current = "";
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    const renderedBuffer = renderedBufferRef.current;
    if (!buffer) {
      terminal.clear();
      renderedBufferRef.current = "";
      return;
    }

    if (buffer.startsWith(renderedBuffer)) {
      const chunk = buffer.slice(renderedBuffer.length);
      if (chunk) {
        terminal.write(chunk);
        focusTerminalSoon();
      }
    } else {
      terminal.reset();
      terminal.write(buffer);
      focusTerminalSoon();
    }
    renderedBufferRef.current = buffer;
  }, [buffer]);

  useEffect(() => {
    focusTerminalSoon();
  }, [running]);

  return (
    <div
      className="flex min-h-0 shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground"
      style={{ flexBasis: height, height }}
    >
      <div
        aria-label="Resize terminal"
        className="terminal-resize-handle"
        onPointerDown={startPaneResize}
        role="separator"
      />
      <div className="flex h-9 items-center justify-between gap-2 border-b border-border bg-secondary/45 px-2">
        <div className="flex min-w-0 items-center gap-2">
          <TerminalSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-xs font-medium">
              {projectName ? `${projectName} terminal` : "Project terminal"}
          </span>
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
            {cwd || "Select a project"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            aria-label="Copy terminal output"
            className="h-7 w-7"
            disabled={!buffer}
            onClick={onCopyAll}
            size="icon"
            title="Copy terminal output"
            variant="ghost"
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
          <Button
            aria-label="Clear terminal output"
            className="h-7 w-7"
            disabled={!buffer}
            onClick={onClear}
            size="icon"
            title="Clear terminal output"
            variant="ghost"
          >
            <Eraser className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="terminal-frame min-h-0 flex-1 bg-[#111110] p-1" onMouseDown={focusTerminalSoon}>
        <div
          aria-label="Project terminal"
          className="h-full outline-none"
          ref={terminalFrameRef}
        />
      </div>
    </div>
  );
}

function ProjectPanel({
  actionPending,
  logClearPending,
  onAction,
  onClearLogs,
  onEdit,
  onOpen,
  selected,
  service,
}: ProjectPanelProps) {
  const [copiedLogs, setCopiedLogs] = useState(false);
  const logFrameRef = useRef<HTMLPreElement>(null);
  const isRunning = service.state === "ready" || service.state === "running";
  const logText = serviceLogText(service.logLines);

  async function copyLogs() {
    await copyText(logText);
    setCopiedLogs(true);
    window.setTimeout(() => setCopiedLogs(false), 1200);
  }

  function handleLogKeyDown(event: KeyboardEvent<HTMLPreElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selectElementText(logFrameRef.current);
    }
  }

  return (
    <article
      className={`flex min-h-0 min-w-0 flex-col rounded-lg border bg-card p-3 text-card-foreground ${
        selected ? "border-primary" : "border-border"
      }`}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <ServiceLogo logoPath={service.resolvedLogoPath} name={service.name} size="md" />
          <div className="min-w-0">
            <div className="mb-1 flex min-w-0 items-center gap-2">
              <h3 className="truncate font-serif text-xl font-semibold">{service.name}</h3>
              <span className={`status-pill ${stateClass(service.state)}`}>
                <Activity className="h-3 w-3" />
                {stateLabel(service.state)}
              </span>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {service.pid ? `pid ${service.pid}` : "no pid"} /{" "}
              {formatUptime(service.uptimeSeconds)}
            </p>
          </div>
        </div>
        <Button onClick={onEdit} size="icon" title="Edit project" variant="ghost">
          <Edit3 className="h-4 w-4" />
        </Button>
      </div>

      <div className="mb-3 space-y-2 rounded-md border border-border bg-secondary/50 p-3 text-sm">
        <button className="metadata-button" onClick={() => onOpen(service.path)} type="button">
          <FolderOpen className="h-4 w-4 text-muted-foreground" />
          <span className="truncate">{service.path}</span>
        </button>
        <button
          className="metadata-button"
          disabled={!service.url}
          onClick={() => service.url && onOpen(service.url)}
          type="button"
        >
          <Globe2 className="h-4 w-4 text-muted-foreground" />
          <span className="truncate">{service.url || "no project address"}</span>
        </button>
        <div className="grid grid-cols-[18px_minmax(0,1fr)] items-center gap-2 text-muted-foreground">
          <TerminalSquare className="h-4 w-4" />
          <span className="truncate font-mono text-xs text-foreground">{service.command}</span>
        </div>
      </div>

      <div className="mb-3 grid grid-cols-3 gap-2">
        <Button
          disabled={isRunning || actionPending}
          onClick={() => onAction("start")}
          size="sm"
          variant="primary"
        >
          <Play className="h-3.5 w-3.5" />
          Start
        </Button>
        <Button
          disabled={!isRunning || actionPending}
          onClick={() => onAction("stop")}
          size="sm"
          variant="secondary"
        >
          <Square className="h-3.5 w-3.5" />
          Stop
        </Button>
        <Button disabled={actionPending} onClick={() => onAction("restart")} size="sm">
          <RefreshCcw className="h-3.5 w-3.5" />
          Restart
        </Button>
      </div>

      <div className="relative min-h-0 flex-1">
        <div className="absolute right-2 top-2 z-10 flex gap-1">
          <Button
            aria-label="Copy logs"
            className="h-7 w-7 border border-border bg-card/95 text-foreground shadow-sm hover:bg-muted"
            onClick={copyLogs}
            size="icon"
            title={copiedLogs ? "Copied logs" : "Copy logs"}
            variant="secondary"
          >
            {copiedLogs ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
          <Button
            aria-label="Clear logs"
            className="h-7 w-7 border border-border bg-card/95 text-foreground shadow-sm hover:bg-muted"
            disabled={logClearPending}
            onClick={onClearLogs}
            size="icon"
            title="Clear logs"
            variant="secondary"
          >
            <Eraser className="h-3.5 w-3.5" />
          </Button>
        </div>
        <pre
          aria-label={`${service.name} logs`}
          className="log-frame h-full"
          onKeyDown={handleLogKeyDown}
          ref={logFrameRef}
          tabIndex={0}
        >
          {logText}
        </pre>
      </div>

      {service.lastExit ? (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-border bg-secondary/50 p-2 text-xs text-muted-foreground">
          <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 overflow-hidden text-ellipsis">{service.lastExit}</span>
        </div>
      ) : null}
    </article>
  );
}

type ServiceLogoProps = {
  logoPath: string | null | undefined;
  name: string;
  size?: "sm" | "md" | "lg";
};

function ServiceLogo({ logoPath, name, size = "md" }: ServiceLogoProps) {
  const src = logoImageSource(logoPath);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = Boolean(src && failedSrc !== src);

  useEffect(() => {
    setFailedSrc(null);
  }, [src]);

  return (
    <span aria-hidden="true" className={`service-logo service-logo-${size}`}>
      {showImage ? (
        <img alt="" onError={() => setFailedSrc(src)} src={src ?? undefined} />
      ) : (
        <span>{initialsFromName(name)}</span>
      )}
    </span>
  );
}

type LogoFieldProps = {
  inputId: string;
  label: string;
  value: string;
  detectedLogoPath: string | null | undefined;
  loading?: boolean;
  browseDisabled?: boolean;
  onBrowse: () => void;
  onChange: (value: string) => void;
  onClear: () => void;
};

function LogoField({
  browseDisabled = false,
  detectedLogoPath,
  inputId,
  label,
  loading = false,
  onBrowse,
  onChange,
  onClear,
  value,
}: LogoFieldProps) {
  const status = value.trim() ? "Manual" : detectedLogoPath ? "Auto" : "None";

  return (
    <div className="text-sm">
      <div className="mb-1 flex items-center justify-between gap-2">
        <label className="font-medium text-muted-foreground" htmlFor={inputId}>
          {label}
        </label>
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          {loading ? <LoaderCircle className="h-3 w-3 animate-spin" /> : null}
          {status}
        </span>
      </div>
      <div className="grid grid-cols-[44px_minmax(0,1fr)_auto_auto] items-center gap-2">
        <ServiceLogo logoPath={detectedLogoPath} name={basenameFromPath(value) || "Vmux"} />
        <input
          className="h-9 w-full rounded-md border border-input bg-card px-3 font-mono text-xs text-foreground outline-none transition placeholder:text-muted-foreground/70 focus:border-primary focus:ring-2 focus:ring-ring/20"
          id={inputId}
          onChange={(event) => onChange(event.target.value)}
          placeholder={detectedLogoPath ? basenameFromPath(detectedLogoPath) : "auto"}
          value={value}
        />
        <Button
          aria-label="Select project logo"
          className="h-9 w-9"
          disabled={browseDisabled}
          onClick={onBrowse}
          size="icon"
          title="Select project logo"
          variant="secondary"
        >
          <ImageIcon className="h-4 w-4" />
        </Button>
        <Button
          aria-label="Clear project logo"
          className="h-9 w-9"
          disabled={!value.trim()}
          onClick={onClear}
          size="icon"
          title="Use auto-detected logo"
          variant="ghost"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      {detectedLogoPath ? (
        <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
          {value.trim() ? resolveDraftLogoPath(value, "") : detectedLogoPath}
        </p>
      ) : null}
    </div>
  );
}

type FieldProps = {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
};

function Field({ label, onChange, placeholder, value }: FieldProps) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-muted-foreground">{label}</span>
      <input
        className="h-9 w-full rounded-md border border-input bg-card px-3 text-foreground outline-none transition placeholder:text-muted-foreground/70 focus:border-primary focus:ring-2 focus:ring-ring/20"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
    </label>
  );
}

type CommandFieldProps = FieldProps & {
  inputId: string;
  loading?: boolean;
  suggestions: CommandSuggestion[];
};

function CommandField({
  inputId,
  label,
  loading = false,
  onChange,
  placeholder,
  suggestions,
  value,
}: CommandFieldProps) {
  const [open, setOpen] = useState(false);
  const search = value.trim().toLowerCase();
  const visibleSuggestions = suggestions
    .filter((suggestion) => {
      if (!search) {
        return true;
      }

      return `${suggestion.command} ${suggestion.name} ${suggestion.source}`
        .toLowerCase()
        .includes(search);
    })
    .slice(0, 8);
  const hasSuggestions = visibleSuggestions.length > 0;

  return (
    <div className="relative text-sm" onBlur={() => window.setTimeout(() => setOpen(false), 100)}>
      <label className="mb-1 block font-medium text-muted-foreground" htmlFor={inputId}>
        {label}
      </label>
      <div className="relative">
        <input
          aria-autocomplete="list"
          aria-expanded={open && hasSuggestions}
          className="h-9 w-full rounded-md border border-input bg-card px-3 pr-9 font-mono text-xs text-foreground outline-none transition placeholder:text-muted-foreground/70 focus:border-primary focus:ring-2 focus:ring-ring/20"
          id={inputId}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder={placeholder}
          role="combobox"
          value={value}
        />
        <button
          aria-label="Show command suggestions"
          className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted disabled:pointer-events-none disabled:opacity-45"
          disabled={!loading && suggestions.length === 0}
          onClick={() => setOpen((current) => !current)}
          onMouseDown={(event) => event.preventDefault()}
          type="button"
        >
          {loading ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <ChevronDown className={`h-4 w-4 transition ${open ? "rotate-180" : ""}`} />
          )}
        </button>
      </div>

      {open && hasSuggestions ? (
        <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border border-border bg-popover p-1 shadow-lg">
          {visibleSuggestions.map((suggestion) => (
            <button
              className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded px-2 py-1.5 text-left transition hover:bg-muted focus:bg-muted focus:outline-none"
              key={`${suggestion.source}:${suggestion.name}`}
              onMouseDown={(event) => {
                event.preventDefault();
                onChange(suggestion.command);
                setOpen(false);
              }}
              type="button"
            >
              <span className="truncate font-mono text-xs text-foreground">
                {suggestion.command}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {suggestion.source} scripts.{suggestion.name}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

type PathFieldProps = FieldProps & {
  inputId: string;
  browseDisabled?: boolean;
  onBrowse: () => void;
};

function PathField({
  browseDisabled = false,
  inputId,
  label,
  onBrowse,
  onChange,
  placeholder,
  value,
}: PathFieldProps) {
  return (
    <div className="text-sm">
      <label className="mb-1 block font-medium text-muted-foreground" htmlFor={inputId}>
        {label}
      </label>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <input
          className="h-9 w-full rounded-md border border-input bg-card px-3 font-mono text-xs text-foreground outline-none transition placeholder:text-muted-foreground/70 focus:border-primary focus:ring-2 focus:ring-ring/20"
          id={inputId}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          value={value}
        />
        <Button
          aria-label="Select project path"
          className="h-9 w-9"
          disabled={browseDisabled}
          onClick={onBrowse}
          size="icon"
          title="Select project path"
          variant="secondary"
        >
          <FolderOpen className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
