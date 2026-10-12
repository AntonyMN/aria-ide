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

export interface ToolExecution {
  id: string;
  tool: 'read_file' | 'write_file' | 'terminal_command' | 'list_directory';
  args: Record<string, any>;
  status: 'running' | 'success' | 'error';
  output?: string;
  error?: string;
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
}
