import type {
  LocalModel,
  SystemMemory,
  FileNode,
  ExecutionPhase,
  PlanTask,
  WorkspaceSession,
  ActivityLogItem,
  CommandAuditResult,
  ActiveOllamaModel,
} from '../types';

const API_BASE = 'http://localhost:3001/api';

export async function fetchSystemMemory(): Promise<SystemMemory> {
  const res = await fetch(`${API_BASE}/system/memory`);
  if (!res.ok) throw new Error('Failed to fetch system memory');
  return res.json();
}

export async function fetchModels(): Promise<{
  models: LocalModel[];
  activeModels?: ActiveOllamaModel[];
  systemMemory: SystemMemory;
}> {
  const res = await fetch(`${API_BASE}/models`);
  if (!res.ok) throw new Error('Failed to fetch models');
  return res.json();
}

export async function fetchActiveModels(): Promise<{
  activeModels: ActiveOllamaModel[];
  count: number;
  totalGB: string;
  totalRamGB: string;
  totalVramGB: string;
  systemMemory: SystemMemory;
}> {
  const res = await fetch(`${API_BASE}/models/active`);
  if (!res.ok) throw new Error('Failed to fetch active models');
  return res.json();
}

export async function unloadModel(model: string): Promise<{
  success: boolean;
  model: string;
  offloaded: boolean;
  verified: boolean;
  timeTakenMs: number;
  remainingActiveModels: ActiveOllamaModel[];
  systemMemory: SystemMemory;
}> {
  const res = await fetch(`${API_BASE}/models/unload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to offload model' }));
    throw new Error(err.error || 'Failed to offload model');
  }
  return res.json();
}

export async function unloadAllModels(): Promise<{
  success: boolean;
  offloadedCount: number;
  verified: boolean;
  timeTakenMs: number;
  remainingActiveModels: ActiveOllamaModel[];
  systemMemory: SystemMemory;
}> {
  const res = await fetch(`${API_BASE}/models/unload-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to offload all models' }));
    throw new Error(err.error || 'Failed to offload all models');
  }
  return res.json();
}

export async function switchModelClean(
  toModel: string,
  fromModel?: string,
  unloadAllOther = true
): Promise<{
  success: boolean;
  switchedTo: string;
  offloadedModels: string[];
  verified: boolean;
  activeModels: ActiveOllamaModel[];
  systemMemory: SystemMemory;
}> {
  const res = await fetch(`${API_BASE}/models/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toModel, fromModel, unloadAllOther }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to switch model' }));
    throw new Error(err.error || 'Failed to switch model');
  }
  return res.json();
}

export interface BootProgress {
  stage: string;
  percent: number;
  message: string;
}

export async function bootModelStream(
  model: string,
  onProgress?: (progress: BootProgress) => void
): Promise<{ success: boolean; verified: boolean; model: string; alreadyLoaded?: boolean; timeTakenMs?: number }> {
  const res = await fetch(`${API_BASE}/models/boot-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to boot model' }));
    throw new Error(err.error || 'Failed to boot model');
  }

  if (!res.body) throw new Error('No stream body returned for model boot');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult = { success: false, verified: false, model };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const ev of events) {
      if (!ev.trim()) continue;
      const lines = ev.split('\n');
      let eventType = 'message';
      let dataStr = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) eventType = line.substring(7);
        if (line.startsWith('data: ')) dataStr = line.substring(6);
      }

      if (eventType === 'progress' && dataStr) {
        try {
          const p = JSON.parse(dataStr);
          onProgress?.(p);
        } catch (e) {}
      } else if (eventType === 'done' && dataStr) {
        try {
          finalResult = JSON.parse(dataStr);
        } catch (e) {}
      } else if (eventType === 'error' && dataStr) {
        try {
          const err = JSON.parse(dataStr);
          throw new Error(err.error || 'Model boot failed');
        } catch (e: any) {
          throw e;
        }
      }
    }
  }

  return finalResult;
}

export async function bootModelDirect(model: string): Promise<{
  success: boolean;
  verified: boolean;
  model: string;
  alreadyLoaded?: boolean;
  timeTakenMs?: number;
  activeModels?: ActiveOllamaModel[];
}> {
  const res = await fetch(`${API_BASE}/models/boot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to boot model' }));
    throw new Error(err.error || 'Failed to boot model');
  }
  return res.json();
}

export async function fetchInitialWorkspace(): Promise<{ path: string | null; cwd: string }> {
  const res = await fetch(`${API_BASE}/workspace/initial`);
  if (!res.ok) throw new Error('Failed to fetch initial workspace');
  return res.json();
}

export async function openWorkspaceCli(targetPath: string): Promise<{ success: boolean; path: string }> {
  const res = await fetch(`${API_BASE}/workspace/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: targetPath }),
  });
  if (!res.ok) throw new Error('Failed to open workspace');
  return res.json();
}

export async function installCliToPath(): Promise<{ success: boolean; installedPath: string; instructions: string }> {
  const res = await fetch(`${API_BASE}/system/install-cli`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error('Failed to install aria to PATH');
  return res.json();
}

export async function fetchFileTree(dirPath?: string): Promise<{ rootPath: string; tree: FileNode[] }> {
  const url = dirPath ? `${API_BASE}/workspace/tree?path=${encodeURIComponent(dirPath)}` : `${API_BASE}/workspace/tree`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch file tree');
  return res.json();
}

export async function readFileContent(filePath: string): Promise<{ path: string; content: string; size: number }> {
  const res = await fetch(`${API_BASE}/workspace/file?path=${encodeURIComponent(filePath)}`);
  if (!res.ok) throw new Error('Failed to read file');
  return res.json();
}

export async function saveFileContent(filePath: string, content: string): Promise<{ success: boolean; path: string }> {
  const res = await fetch(`${API_BASE}/workspace/file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, content }),
  });
  if (!res.ok) throw new Error('Failed to save file');
  return res.json();
}

export async function createItem(targetPath: string, isDirectory: boolean): Promise<{ success: boolean; path: string }> {
  const res = await fetch(`${API_BASE}/workspace/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: targetPath, isDirectory }),
  });
  if (!res.ok) throw new Error('Failed to create item');
  return res.json();
}

export async function renameItem(oldPath: string, newPath: string): Promise<{ success: boolean; newPath: string }> {
  const res = await fetch(`${API_BASE}/workspace/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPath, newPath }),
  });
  if (!res.ok) throw new Error('Failed to rename item');
  return res.json();
}

export async function deleteItem(targetPath: string): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/workspace/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: targetPath }),
  });
  if (!res.ok) throw new Error('Failed to delete item');
  return res.json();
}

export async function runTerminalCommand(command: string, cwd?: string): Promise<{
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  hasError: boolean;
}> {
  const res = await fetch(`${API_BASE}/terminal/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, cwd }),
  });
  if (!res.ok) throw new Error('Failed to execute command');
  return res.json();
}

export function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'jsx':
      return 'javascript';
    case 'rs':
      return 'rust';
    case 'py':
      return 'python';
    case 'json':
      return 'json';
    case 'html':
      return 'html';
    case 'css':
      return 'css';
    case 'md':
      return 'markdown';
    case 'sh':
    case 'bash':
      return 'shell';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'toml':
      return 'toml';
    case 'sql':
      return 'sql';
    default:
      return 'plaintext';
  }
}

export async function stopAgentGeneration(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/agent/stop`, { method: 'POST' });
    return res.ok;
  } catch (e) {
    return false;
  }
}

export async function generateImplementationPlan(params: {
  model: string;
  prompt: string;
  workspacePath: string;
}): Promise<{
  success: boolean;
  planMarkdown: string;
  phases: ExecutionPhase[];
  tasks: PlanTask[];
  planFilePath: string;
  planFileRelative: string;
}> {
  const res = await fetch(`${API_BASE}/agent/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || 'Failed to generate implementation plan');
  }
  return res.json();
}

export async function verifyWorkspaceFiles(params: {
  workspacePath: string;
  files: string[];
}): Promise<{
  success: boolean;
  verified: boolean;
  results: {
    path: string;
    exists: boolean;
    size?: number;
    hasError?: boolean;
    error?: string | null;
  }[];
}> {
  const res = await fetch(`${API_BASE}/agent/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error('Failed to verify workspace files');
  return res.json();
}

export async function fetchWorkspaceSession(dirPath: string): Promise<WorkspaceSession | null> {
  try {
    const res = await fetch(`${API_BASE}/workspace/session?path=${encodeURIComponent(dirPath)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.session || null;
  } catch (e) {
    return null;
  }
}

export async function saveWorkspaceSession(
  workspacePath: string,
  sessionData: Partial<WorkspaceSession>
): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/workspace/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspacePath, sessionData }),
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

export async function fetchWorkspaceActivity(dirPath: string): Promise<ActivityLogItem[]> {
  try {
    const res = await fetch(`${API_BASE}/workspace/activity?path=${encodeURIComponent(dirPath)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.activity || [];
  } catch (e) {
    return [];
  }
}

export async function fetchDirectories(dirPath?: string): Promise<{
  success: boolean;
  currentPath: string;
  parentPath: string | null;
  homePath: string;
  directories: {
    name: string;
    path: string;
    hasIdeSession: boolean;
    subItemCount: number;
  }[];
  hasIdeSession: boolean;
}> {
  const url = dirPath
    ? `${API_BASE}/filesystem/directories?path=${encodeURIComponent(dirPath)}`
    : `${API_BASE}/filesystem/directories`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch directories');
  return res.json();
}

export async function createDirectory(parentPath: string, folderName: string): Promise<{
  success: boolean;
  path: string;
  name: string;
}> {
  const res = await fetch(`${API_BASE}/filesystem/create-directory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentPath, folderName }),
  });
  if (!res.ok) throw new Error('Failed to create folder');
  return res.json();
}

export async function auditCommand(params: {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  currentCwd: string;
  workspacePath: string;
  createdDirs?: string[];
  createdFiles?: string[];
  model?: string;
  goalContext?: string;
}): Promise<CommandAuditResult> {
  const res = await fetch(`${API_BASE}/agent/audit-command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error('Failed to audit command execution');
  return res.json();
}

export async function interruptAgent(params: {
  model: string;
  workspacePath: string;
  currentCwd: string;
  interruptionMessage: string;
  activePlan?: any;
  completedPhases?: any[];
  executedCommands?: any[];
  writtenFiles?: any[];
}): Promise<{
  success: boolean;
  updatedPlanMarkdown: string;
  phases: ExecutionPhase[];
  tasks: PlanTask[];
  wayForward: string;
}> {
  const res = await fetch(`${API_BASE}/agent/interrupt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || 'Failed to process interruption');
  }
  return res.json();
}

export interface LiveStreamCallbacks {
  onQueueStarted?: (data: { total: number; commands: string[]; currentCwd: string }) => void;
  onCommandStarted?: (data: { index: number; command: string; cwd: string }) => void;
  onStdout?: (data: { index: number; chunk: string }) => void;
  onStderr?: (data: { index: number; chunk: string }) => void;
  onCommandFinished?: (data: { index: number; exitCode: number; success: boolean }) => void;
  onCommandAudited?: (data: { index: number; audit: CommandAuditResult }) => void;
  onCwdChanged?: (data: { newCwd: string; relativeCwd: string }) => void;
  onInterrupted?: (data: { index: number; reason: string }) => void;
  onError?: (err: string) => void;
  onQueueCompleted?: (data: { completed: boolean; finalCwd: string; results: any[] }) => void;
}

export async function streamSequentialCommandsLive(
  params: {
    commands: string[];
    workspacePath: string;
    initialCwd?: string;
    model?: string;
    goalContext?: string;
  },
  callbacks: LiveStreamCallbacks,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(`${API_BASE}/terminal/run-live-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify(params),
  });

  if (!res.body) throw new Error('No streaming response body from command runner');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    if (signal?.aborted) break;
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const ev of events) {
      if (!ev.trim()) continue;
      const lines = ev.split('\n');
      let eventType = 'message';
      let dataStr = '';

      for (const line of lines) {
        if (line.startsWith('event: ')) eventType = line.substring(7);
        if (line.startsWith('data: ')) dataStr = line.substring(6);
      }

      if (!dataStr) continue;

      try {
        const parsed = JSON.parse(dataStr);
        switch (eventType) {
          case 'queue_started':
            callbacks.onQueueStarted?.(parsed);
            break;
          case 'command_started':
            callbacks.onCommandStarted?.(parsed);
            break;
          case 'command_stdout':
            callbacks.onStdout?.(parsed);
            break;
          case 'command_stderr':
            callbacks.onStderr?.(parsed);
            break;
          case 'command_finished':
            callbacks.onCommandFinished?.(parsed);
            break;
          case 'command_audited':
            callbacks.onCommandAudited?.(parsed);
            break;
          case 'cwd_changed':
            callbacks.onCwdChanged?.(parsed);
            break;
          case 'interrupted':
            callbacks.onInterrupted?.(parsed);
            break;
          case 'queue_completed':
            callbacks.onQueueCompleted?.(parsed);
            break;
          case 'error':
            callbacks.onError?.(parsed.error);
            break;
        }
      } catch (e) {
        console.error('Failed to parse SSE event:', e);
      }
    }
  }
}


