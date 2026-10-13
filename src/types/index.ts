export interface RamEstimate {
  weightsGB: number;
  kvCacheGB: number;
  runtimeBufferGB: number;
  totalEstimatedGB: number;
}

export type SafetyBadge = 'SAFE' | 'TIGHT' | 'SWAP_HEAVY';

export interface LocalModel {
  name: string;
  source: 'ollama_running' | 'ollama_disk_manifest' | 'huggingface_cache';
  sizeBytes: number;
  sizeGB: string;
  parameterSize: string;
  quantization: string;
  format: string;
  family: string;
  capabilities: string[];
  ramEstimate: RamEstimate;
  safetyBadge: SafetyBadge;
  isRunning: boolean;
}

export interface SystemMemory {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  totalGB: string;
  usedGB: string;
  availableGB: string;
  usedPercent: number;
}

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
  size?: number;
}

export interface OpenTab {
  id: string;
  path: string;
  name: string;
  content: string;
  savedContent: string;
  isDirty: boolean;
  language: string;
}

export interface DiffProposal {
  filePath: string;
  originalContent: string;
  modifiedContent: string;
  explanation?: string;
  status: 'pending' | 'accepted' | 'rejected';
}

export interface PlanTask {
  id: string;
  title: string;
  description?: string;
  completed: boolean;
  phase?: string;
}

export interface ExecutionPhase {
  id: string;
  number: number;
  title: string;
  description: string;
  targetFiles: string[];
  commands: string[];
  status: 'pending' | 'in_progress' | 'completed' | 'error';
  error?: string;
}

export interface CommandAuditResult {
  command: string;
  exitCode: number;
  success: boolean;
  stdout: string;
  stderr: string;
  oldCwd: string;
  newCwd: string;
  relativeCwd: string;
  createdDirs: string[];
  createdFiles: string[];
  status: 'success' | 'warning' | 'error';
  summary: string;
  whatHasBeenDone?: string;
  existingItems?: string[];
  wayForward: string;
  suggestedNextCommands: string[];
}

export interface LiveCommandQueueItem {
  id: string;
  command: string;
  status: 'pending' | 'running' | 'completed' | 'error' | 'interrupted' | 'skipped';
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
  audit?: CommandAuditResult;
  startTime?: number;
  endTime?: number;
}

export interface ToolExecution {
  id: string;
  tool: 'read_file' | 'write_file' | 'terminal_command' | 'list_directory' | 'audit_command';
  args: Record<string, any>;
  status: 'running' | 'success' | 'error';
  output?: string;
  error?: string;
  audit?: CommandAuditResult;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string;
  isStreaming?: boolean;
  toolExecutions?: ToolExecution[];
  diffs?: DiffProposal[];
  plan?: PlanTask[];
  timestamp: number;
  commandAudit?: CommandAuditResult;
  isInterruption?: boolean;
}

export interface ActivityLogItem {
  id: string;
  timestamp: string;
  type: 'file_written' | 'command_executed' | 'command_audited' | 'plan_generated' | 'phase_completed' | 'file_read' | 'interrupted';
  path?: string;
  size?: number;
  command?: string;
  exitCode?: number;
  success?: boolean;
  phaseNumber?: number;
  title?: string;
  auditSummary?: string;
  newCwd?: string;
}

export interface ActivePlanExecution {
  prompt: string;
  phases: ExecutionPhase[];
  currentPhaseIndex: number;
  status: 'idle' | 'executing' | 'paused' | 'interrupted' | 'completed' | 'error';
  autoProceed?: boolean;
  currentCwd?: string;
  lastInterruption?: {
    message: string;
    timestamp: number;
  };
}

export interface WorkspaceSession {
  version?: string;
  updatedAt?: string;
  workspacePath?: string;
  currentCwd?: string;
  selectedModel?: string;
  activeFilePath?: string;
  openTabs?: { path: string; name: string }[];
  messages?: ChatMessage[];
  planTasks?: PlanTask[];
  activePlan?: ActivePlanExecution | null;
}

