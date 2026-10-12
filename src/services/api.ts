import type { LocalModel, SystemMemory, FileNode, ExecutionPhase, PlanTask, WorkspaceSession, ActivityLogItem } from '../types';

const API_BASE = 'http://localhost:3001/api';

export async function fetchSystemMemory(): Promise<SystemMemory> {
  const res = await fetch(`${API_BASE}/system/memory`);
  if (!res.ok) throw new Error('Failed to fetch system memory');
  return res.json();
}

export async function fetchModels(): Promise<{ models: LocalModel[]; systemMemory: SystemMemory }> {
  const res = await fetch(`${API_BASE}/models`);
  if (!res.ok) throw new Error('Failed to fetch models');
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


