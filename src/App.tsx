import React, { useState, useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';
import type {
  LocalModel,
  SystemMemory,
  FileNode,
  OpenTab,
  DiffProposal,
  PlanTask,
  ActivePlanExecution,
  ChatMessage,
  LiveCommandQueueItem,
} from './types';
import {
  fetchModels,
  fetchSystemMemory,
  fetchFileTree,
  readFileContent,
  saveFileContent,
  createItem,
  deleteItem,
  detectLanguage,
  stopAgentGeneration,
  generateImplementationPlan,
  executeAgentStep,
  interpretUserIntent,
  verifyWorkspaceFiles,
  fetchWorkspaceSession,
  saveWorkspaceSession,
  streamSequentialCommandsLive,
  fetchActiveModels,
  unloadAllModels,
  switchModelClean,
  bootModelStream,
  fetchInitialWorkspace,
  installCliToPath,
} from './services/api';
import { FileTree } from './components/FileTree';
import { ModelSelectorModal } from './components/ModelSelectorModal';
import { ModelBootHUD } from './components/ModelBootHUD';
import { TerminalPane } from './components/TerminalPane';
import { DiffReviewModal } from './components/DiffReviewModal';
import { PlanDrawer } from './components/PlanDrawer';
import { AgentChatPane } from './components/AgentChatPane';
import { WorkspacePickerModal } from './components/WorkspacePickerModal';
import { OnScreenCommandRunner } from './components/OnScreenCommandRunner';
import {
  confirmStopGeneration,
  promptText,
  confirmAction,
  showErrorAlert,
  showWarningAlert,
  showSuccessToast,
  showInfoToast,
} from './services/alerts';
import {
  Cpu,
  FolderOpen,
  Save,
  Terminal as TerminalIcon,
  ListTodo,
  X,
  Code2,
  Zap,
  PowerOff,
  RefreshCw,
} from 'lucide-react';

export function App() {
  // System & Model State
  const [models, setModels] = useState<LocalModel[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [systemMemory, setSystemMemory] = useState<SystemMemory | null>(null);
  const [isModelModalOpen, setIsModelModalOpen] = useState(false);

  // LLM Booting / Wake-Up State
  const [isModelBooting, setIsModelBooting] = useState(false);
  const [bootProgress, setBootProgress] = useState(0);
  const [bootStageMessage, setBootStageMessage] = useState('');
  const [bootTargetModel, setBootTargetModel] = useState('');
  const [isAutonomousBootTrigger, setIsAutonomousBootTrigger] = useState(false);

  // Workspace & File Tree State
  const [workspacePath, setWorkspacePath] = useState<string>(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const queryPath = urlParams.get('path') || urlParams.get('workspace');
    if (queryPath) {
      localStorage.setItem('ide_active_workspace', queryPath);
      return queryPath;
    }
    return localStorage.getItem('ide_active_workspace') || '/home/anto/builds/ide';
  });
  const [currentCwd, setCurrentCwd] = useState<string>(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const queryPath = urlParams.get('path') || urlParams.get('workspace');
    if (queryPath) {
      localStorage.setItem('ide_active_cwd', queryPath);
      return queryPath;
    }
    return localStorage.getItem('ide_active_cwd') || localStorage.getItem('ide_active_workspace') || '/home/anto/builds/ide';
  });
  const [isWorkspaceModalOpen, setIsWorkspaceModalOpen] = useState(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const queryPath = urlParams.get('path') || urlParams.get('workspace');
    if (queryPath) return false;
    return !localStorage.getItem('ide_active_workspace');
  });
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string>('');

  // Diff History ref to track original file contents prior to direct apply
  const fileDiffHistoryRef = useRef<Record<string, { originalContent: string; modifiedContent: string }>>({});

  // Tabs & Monaco Editor State
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>('');

  // Bottom Dock State (supports interactive xterm terminal, on-screen live command runner, and implementation plan)
  const [activeDockTab, setActiveDockTab] = useState<'terminal' | 'runner' | 'plan'>('terminal');

  // Live On-Screen Command Queue State
  const [liveQueue, setLiveQueue] = useState<LiveCommandQueueItem[]>([]);
  const [currentQueueIndex, setCurrentQueueIndex] = useState<number>(0);
  const [isQueueRunning, setIsQueueRunning] = useState<boolean>(false);
  const [isQueuePaused, setIsQueuePaused] = useState<boolean>(false);

  // Diff Review State
  const [activeDiff, setActiveDiff] = useState<DiffProposal | null>(null);

  // Implementation Plan State
  const [planTasks, setPlanTasks] = useState<PlanTask[]>([]);
  const [activePlan, setActivePlan] = useState<ActivePlanExecution | null>(null);

  // Agent Chat State
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesRef = useRef<ChatMessage[]>([]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const getCleanConversationHistory = (extraUserMsg?: ChatMessage): { role: string; content: string }[] => {
    const list = extraUserMsg ? [...messagesRef.current, extraUserMsg] : messagesRef.current;
    return list
      .filter((m) => {
        if (!m.content || !m.content.trim()) return false;
        if (m.content.startsWith('⏳ **Please wait as model is being booted')) return false;
        if (m.content.startsWith('🧠 **Analyzing project context')) return false;
        if (m.content.startsWith('❌ Error:')) return false;
        return m.role === 'user' || m.role === 'assistant';
      })
      .slice(-10)
      .map((m) => ({
        role: m.role,
        content: m.content.trim(),
      }));
  };

  // Resizable Panels State
  const [leftSidebarWidth, setLeftSidebarWidth] = useState<number>(() => {
    const saved = localStorage.getItem('ide_left_sidebar_width');
    return saved ? Math.max(160, Math.min(650, parseInt(saved, 10) || 260)) : 260;
  });

  const [rightSidebarWidth, setRightSidebarWidth] = useState<number>(() => {
    const saved = localStorage.getItem('ide_right_sidebar_width');
    return saved ? Math.max(280, Math.min(850, parseInt(saved, 10) || 420)) : 420;
  });

  const [bottomDockHeight, setBottomDockHeight] = useState<number>(() => {
    const saved = localStorage.getItem('ide_bottom_dock_height');
    return saved ? Math.max(90, Math.min(650, parseInt(saved, 10) || 240)) : 240;
  });

  const [dragging, setDragging] = useState<'left' | 'right' | 'bottom' | null>(null);

  const dragStartRef = useRef<{
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
  }>({ startX: 0, startY: 0, startWidth: 0, startHeight: 0 });

  const leftWidthRef = useRef(leftSidebarWidth);
  leftWidthRef.current = leftSidebarWidth;

  const rightWidthRef = useRef(rightSidebarWidth);
  rightWidthRef.current = rightSidebarWidth;

  // Persist sidebar dimensions
  useEffect(() => {
    localStorage.setItem('ide_left_sidebar_width', String(leftSidebarWidth));
  }, [leftSidebarWidth]);

  useEffect(() => {
    localStorage.setItem('ide_right_sidebar_width', String(rightSidebarWidth));
  }, [rightSidebarWidth]);

  useEffect(() => {
    localStorage.setItem('ide_bottom_dock_height', String(bottomDockHeight));
  }, [bottomDockHeight]);

  // Mouse move and up handler for smooth panel resizing
  useEffect(() => {
    if (!dragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (dragging === 'left') {
        const delta = e.clientX - dragStartRef.current.startX;
        const maxAllowed = Math.min(650, window.innerWidth - rightWidthRef.current - 250);
        const newWidth = Math.max(160, Math.min(maxAllowed, dragStartRef.current.startWidth + delta));
        setLeftSidebarWidth(newWidth);
      } else if (dragging === 'right') {
        const delta = dragStartRef.current.startX - e.clientX;
        const maxAllowed = Math.min(850, window.innerWidth - leftWidthRef.current - 250);
        const newWidth = Math.max(280, Math.min(maxAllowed, dragStartRef.current.startWidth + delta));
        setRightSidebarWidth(newWidth);
      } else if (dragging === 'bottom') {
        const delta = dragStartRef.current.startY - e.clientY;
        const maxAllowed = Math.min(650, window.innerHeight - 180);
        const newHeight = Math.max(90, Math.min(maxAllowed, dragStartRef.current.startHeight + delta));
        setBottomDockHeight(newHeight);
      }
    };

    const handleMouseUp = () => {
      setDragging(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragging]);

  const handleStartResizeLeft = (e: React.MouseEvent) => {
    e.preventDefault();
    dragStartRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startWidth: leftSidebarWidth,
      startHeight: 0,
    };
    setDragging('left');
  };

  const handleStartResizeRight = (e: React.MouseEvent) => {
    e.preventDefault();
    dragStartRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startWidth: rightSidebarWidth,
      startHeight: 0,
    };
    setDragging('right');
  };

  const handleStartResizeBottom = (e: React.MouseEvent) => {
    e.preventDefault();
    dragStartRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startWidth: 0,
      startHeight: bottomDockHeight,
    };
    setDragging('bottom');
  };

  // Initial Load: Discover models & workspace
  const loadModelsAndHardware = async () => {
    try {
      const data = await fetchModels();
      setModels(data.models);
      setSystemMemory(data.systemMemory);

      // Auto-select model if none selected yet: prefer model already loaded in RAM, then safe model
      if (!selectedModel && data.models.length > 0) {
        const loaded = data.models.find((m) => m.isLoadedInRam);
        const safe = data.models.find((m) => m.safetyBadge === 'SAFE') || data.models[0];
        setSelectedModel(loaded ? loaded.name : safe.name);
      }
    } catch (err) {
      console.error('Failed to discover models:', err);
    }
  };

  // Safe Model Switching: Verifies previous models are offloaded from RAM before activating new model
  const handleSwitchModel = async (newModel: string) => {
    if (newModel === selectedModel) return;
    try {
      const activeRes = await fetchActiveModels();
      const otherActive = activeRes.activeModels.filter((m) => m.name !== newModel);

      if (otherActive.length > 0) {
        const otherNames = otherActive.map((m) => m.name).join(', ');
        showInfoToast(`Offloading previous model (${otherNames}) from RAM...`);
        const res = await switchModelClean(newModel, selectedModel);
        if (res.verified) {
          showSuccessToast(`RAM cleared! Active model is now ${newModel}.`);
        }
      } else {
        showSuccessToast(`Active model is now ${newModel}.`);
      }

      setSelectedModel(newModel);
      await loadModelsAndHardware();
    } catch (err: any) {
      console.error('Failed to switch model cleanly:', err);
      showErrorAlert('Model Switch Failed', err.message || 'Could not cleanly switch models');
    }
  };

  // Quick Offload All models from RAM
  const handleQuickOffloadAll = async (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    try {
      showInfoToast('Reclaiming RAM: offloading resident models from memory...');
      const res = await unloadAllModels();
      if (res.verified) {
        showSuccessToast('All models offloaded. RAM is fully preserved.');
      }
      await loadModelsAndHardware();
    } catch (err: any) {
      console.error('Failed to offload models:', err);
      showErrorAlert('Offload Failed', err.message || 'Could not offload models from RAM');
    }
  };

  // LLM Booting Sequence with live HUD progress tracking
  const runModelBootSequence = async (
    modelToBoot: string,
    isAutonomousTrigger = false
  ): Promise<boolean> => {
    try {
      setIsModelBooting(true);
      setBootTargetModel(modelToBoot);
      setBootProgress(10);
      setBootStageMessage(`Preparing to boot ${modelToBoot}...`);
      setIsAutonomousBootTrigger(isAutonomousTrigger);

      const result = await bootModelStream(modelToBoot, (p) => {
        setBootProgress(p.percent);
        setBootStageMessage(p.message);
      });

      if (result.verified || result.success) {
        setBootProgress(100);
        setBootStageMessage(`🎉 Model ${modelToBoot} is online and active in RAM!`);
        showSuccessToast(`Model ${modelToBoot} is now active in RAM and ready.`);
        await loadModelsAndHardware();
        // Give 600ms so user can see 100% completion in HUD
        await new Promise((r) => setTimeout(r, 600));
        return true;
      } else {
        throw new Error(`Model ${modelToBoot} could not be verified in RAM`);
      }
    } catch (err: any) {
      console.error('Failed to boot model:', err);
      showErrorAlert('LLM Boot Failed', err.message || 'Could not boot model into RAM');
      return false;
    } finally {
      setIsModelBooting(false);
      setBootTargetModel('');
      setBootProgress(0);
      setBootStageMessage('');
      setIsAutonomousBootTrigger(false);
    }
  };

  // Manual Boot action triggered by user
  const handleManualBoot = async (modelToBoot: string) => {
    if (!modelToBoot) {
      await showWarningAlert('Model Required', 'Please choose a local AI model to boot first.');
      setIsModelModalOpen(true);
      return;
    }
    await runModelBootSequence(modelToBoot, false);
  };

  const loadWorkspace = async (targetPath?: string, restoreSession = false) => {
    try {
      const path = targetPath || workspacePath;
      const res = await fetchFileTree(path);
      setFileTree(res.tree);
      setWorkspacePath(res.rootPath);

      if (restoreSession) {
        // Try restoring session from .ide/session.json
        const session = await fetchWorkspaceSession(res.rootPath);
        if (session) {
          if (Array.isArray(session.messages) && session.messages.length > 0) {
            setMessages(session.messages);
          }
          if (Array.isArray(session.planTasks) && session.planTasks.length > 0) {
            setPlanTasks(session.planTasks);
            setActiveDockTab('plan');
          }
          if (session.selectedModel) {
            setSelectedModel(session.selectedModel);
          }
          if (Array.isArray(session.openTabs) && session.openTabs.length > 0) {
            for (const t of session.openTabs) {
              try {
                const { content } = await readFileContent(t.path);
                const name = t.path.split('/').pop() || t.path;
                const newTab: OpenTab = {
                  id: t.path,
                  path: t.path,
                  name,
                  content,
                  savedContent: content,
                  isDirty: false,
                  language: detectLanguage(t.path),
                };
                setTabs((prev) => {
                  if (prev.some((old) => old.path === t.path)) return prev;
                  return [...prev, newTab];
                });
              } catch (e) {}
            }
            if (session.activeFilePath) {
              setActiveFilePath(session.activeFilePath);
              setActiveTabId(session.activeFilePath);
            }
          }
          if (session.activePlan) {
            setActivePlan(session.activePlan);
          }
          showSuccessToast(`Session restored from .ide/ (${session.messages?.length || 0} messages)`);
        }
      }
    } catch (err) {
      console.error('Failed to load file tree:', err);
    }
  };

  // Install CLI to PATH helper
  const handleInstallCli = async () => {
    try {
      showInfoToast('Installing "aria" command into your PATH...');
      const res = await installCliToPath();
      if (res.success) {
        showSuccessToast(`✓ 'aria' installed at ${res.installedPath}! You can now run "aria ." from any terminal.`);
      }
    } catch (err: any) {
      console.error('Failed to install CLI:', err);
      showErrorAlert('Installation Failed', err.message || 'Could not install aria to PATH');
    }
  };

  useEffect(() => {
    loadModelsAndHardware();

    const initWorkspace = async () => {
      // 1. Check if URL has ?path= or ?workspace=
      const urlParams = new URLSearchParams(window.location.search);
      const queryPath = urlParams.get('path') || urlParams.get('workspace');
      if (queryPath) {
        await loadWorkspace(queryPath, true);
        return;
      }

      // 2. Check if backend has INITIAL_WORKSPACE from CLI (aria .)
      try {
        const initRes = await fetchInitialWorkspace();
        if (initRes.path && initRes.path !== workspacePath) {
          setWorkspacePath(initRes.path);
          setCurrentCwd(initRes.path);
          localStorage.setItem('ide_active_workspace', initRes.path);
          setIsWorkspaceModalOpen(false);
          await loadWorkspace(initRes.path, true);
          return;
        }
      } catch (e) {}

      // 3. Fallback to normal saved workspace
      loadWorkspace(undefined, true);
    };

    initWorkspace();

    // Poll memory periodically
    const interval = setInterval(async () => {
      try {
        const mem = await fetchSystemMemory();
        setSystemMemory(mem);
      } catch (e) {}
    }, 10000);

    return () => clearInterval(interval);
  }, []);

  // Auto-save session to .ide/session.json whenever state changes (debounced)
  const isInitialMountRef = useRef(true);
  useEffect(() => {
    if (isInitialMountRef.current) {
      isInitialMountRef.current = false;
      return;
    }
    const timer = setTimeout(() => {
      if (workspacePath && (messages.length > 0 || planTasks.length > 0 || tabs.length > 0 || activePlan)) {
        saveWorkspaceSession(workspacePath, {
          workspacePath,
          selectedModel,
          activeFilePath,
          openTabs: tabs.map((t) => ({ path: t.path, name: t.name })),
          messages,
          planTasks,
          activePlan,
        });
      }
    }, 1500);

    return () => clearTimeout(timer);
  }, [messages, planTasks, activePlan, tabs, activeFilePath, selectedModel, workspacePath]);

  // Open file in editor tab
  const handleSelectFile = async (filePath: string, providedContent?: string) => {
    setActiveFilePath(filePath);
    const existing = tabs.find((t) => t.path === filePath);
    if (existing && providedContent === undefined) {
      setActiveTabId(existing.id);
      return;
    }

    try {
      const content = providedContent !== undefined ? providedContent : (await readFileContent(filePath)).content;
      const name = filePath.split('/').pop() || filePath;
      const newTab: OpenTab = {
        id: filePath,
        path: filePath,
        name,
        content,
        savedContent: content,
        isDirty: false,
        language: detectLanguage(filePath),
      };

      setTabs((prev) => {
        const withoutOld = prev.filter((t) => t.path !== filePath);
        return [...withoutOld, newTab];
      });
      setActiveTabId(newTab.id);
    } catch (err) {
      console.error('Failed to open file:', err);
    }
  };

  // Close editor tab
  const handleCloseTab = async (tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const tabToClose = tabs.find((t) => t.id === tabId);
    if (tabToClose?.isDirty) {
      const discard = await confirmAction({
        title: 'Unsaved Changes',
        text: `"${tabToClose.name}" has unsaved changes. Do you want to close it without saving?`,
        confirmButtonText: 'Discard & Close',
        isDanger: true,
      });
      if (!discard) return;
    }

    const remaining = tabs.filter((t) => t.id !== tabId);
    setTabs(remaining);
    if (activeTabId === tabId) {
      if (remaining.length > 0) {
        setActiveTabId(remaining[remaining.length - 1].id);
        setActiveFilePath(remaining[remaining.length - 1].path);
      } else {
        setActiveTabId('');
        setActiveFilePath('');
      }
    }
  };

  // Content change in Monaco
  const handleEditorChange = (newContent: string | undefined) => {
    if (newContent === undefined) return;
    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeTabId
          ? {
              ...t,
              content: newContent,
              isDirty: newContent !== t.savedContent,
            }
          : t
      )
    );
  };

  // Save current active tab
  const handleSaveActiveTab = async () => {
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (!activeTab || !activeTab.isDirty) return;

    try {
      await saveFileContent(activeTab.path, activeTab.content);
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTabId
            ? { ...t, savedContent: t.content, isDirty: false }
            : t
        )
      );
      loadWorkspace();
      showSuccessToast(`Saved "${activeTab.name}"`);
    } catch (err: any) {
      console.error('Failed to save file:', err);
      showErrorAlert('Save Failed', err.message || String(err));
    }
  };

  // Keyboard shortcut Ctrl+S
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSaveActiveTab();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTabId, tabs]);

  // Create file or folder with SweetAlert2
  const handleCreateItem = async (parentPath: string, isDirectory: boolean) => {
    const parentName = parentPath.split('/').pop() || parentPath;
    const name = await promptText({
      title: `Create ${isDirectory ? 'Folder' : 'File'}`,
      text: `Enter name for new ${isDirectory ? 'directory' : 'file'} in "${parentName}":`,
      placeholder: isDirectory ? 'e.g. components' : 'e.g. index.ts',
      confirmButtonText: 'Create',
    });
    if (!name) return;

    const targetPath = `${parentPath}/${name}`;
    try {
      await createItem(targetPath, isDirectory);
      loadWorkspace();
      if (!isDirectory) {
        handleSelectFile(targetPath);
      }
      showSuccessToast(`${isDirectory ? 'Folder' : 'File'} "${name}" created`);
    } catch (err: any) {
      await showErrorAlert('Creation Failed', err.message || String(err));
    }
  };

  // Delete file or folder with SweetAlert2
  const handleDeleteItem = async (targetPath: string) => {
    const itemName = targetPath.split('/').pop() || targetPath;
    const confirmed = await confirmAction({
      title: 'Delete Item?',
      text: `Are you sure you want to permanently delete "${itemName}"? This action cannot be undone.`,
      confirmButtonText: 'Delete Permanently',
      isDanger: true,
    });
    if (!confirmed) return;

    try {
      await deleteItem(targetPath);
      setTabs((prev) => prev.filter((t) => t.path !== targetPath));
      loadWorkspace();
      showSuccessToast(`"${itemName}" deleted`);
    } catch (err: any) {
      await showErrorAlert('Deletion Failed', err.message || String(err));
    }
  };

  // Switch workspace path: open visual directory explorer
  const handleSwitchWorkspace = () => {
    setIsWorkspaceModalOpen(true);
  };

  // Select workspace from WorkspacePickerModal and restore session
  const handleSelectWorkspace = async (newPath: string) => {
    try {
      setWorkspacePath(newPath);
      localStorage.setItem('ide_active_workspace', newPath);
      // Reset state for newly selected workspace
      setTabs([]);
      setActiveFilePath('');
      setActiveTabId('');
      setMessages([]);
      setPlanTasks([]);
      setActivePlan(null);
      await loadWorkspace(newPath, true);
      setIsWorkspaceModalOpen(false);
    } catch (err: any) {
      showErrorAlert('Workspace Error', err.message || 'Could not open workspace');
    }
  };

  // Helper to look up original file content before AI direct overwrite
  const getOriginalContent = (filePath: string): string | undefined => {
    const clean = filePath.replace(/^(\.\/|\/)/, '');
    if (fileDiffHistoryRef.current[filePath]?.originalContent !== undefined) {
      return fileDiffHistoryRef.current[filePath].originalContent;
    }
    if (fileDiffHistoryRef.current[clean]?.originalContent !== undefined) {
      return fileDiffHistoryRef.current[clean].originalContent;
    }
    const full = filePath.startsWith('/') ? filePath : `${workspacePath}/${clean}`;
    if (fileDiffHistoryRef.current[full]?.originalContent !== undefined) {
      return fileDiffHistoryRef.current[full].originalContent;
    }
    return undefined;
  };

  // Keep changes applied directly by the AI
  const handleKeepDiff = (diff: DiffProposal) => {
    setActiveDiff(null);
    showSuccessToast(`Kept changes in ${diff.filePath}`);
  };

  // Revert Diff back to original file content
  const handleRevertDiff = async (diff: DiffProposal) => {
    const fullPath = diff.filePath.startsWith('/')
      ? diff.filePath
      : `${workspacePath}/${diff.filePath}`;
    try {
      if (!diff.originalContent || diff.originalContent.startsWith('// New file')) {
        await deleteItem(fullPath);
        setTabs((prev) => prev.filter((t) => t.path !== fullPath));
        if (activeFilePath === fullPath) {
          setActiveFilePath('');
          setActiveTabId('');
        }
        showSuccessToast(`Reverted: deleted new file ${diff.filePath}`);
      } else {
        await saveFileContent(fullPath, diff.originalContent);
        setTabs((prev) =>
          prev.map((t) =>
            t.path === fullPath
              ? {
                  ...t,
                  content: diff.originalContent,
                  savedContent: diff.originalContent,
                  isDirty: false,
                }
              : t
          )
        );
        showSuccessToast(`Reverted changes in ${diff.filePath}`);
      }
      setActiveDiff(null);
      await loadWorkspace();
    } catch (err: any) {
      await showErrorAlert('Failed to Revert Changes', err.message || String(err));
    }
  };

  const abortControllerRef = useRef<AbortController | null>(null);
  const pendingUserGuidanceRef = useRef<string[]>([]);
  const isAutonomousLoopPausedRef = useRef<boolean>(false);
  const activeAutonomousTaskRef = useRef<{
    prompt: string;
    planMarkdown: string;
    planTasks: PlanTask[];
    stepIndex: number;
    completedActions: any[];
    lastActionResult: any;
    thinkingEnabled: boolean;
    conversationHistory?: { role: string; content: string }[];
  } | null>(null);

  // Stop Generation with SweetAlert2 confirmation
  const handleStopGeneration = async () => {
    if (!isStreaming) return;

    const confirmed = await confirmStopGeneration();
    if (!confirmed) {
      return; // User canceled the stop prompt; continue generating!
    }

    isAutonomousLoopPausedRef.current = true;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    await stopAgentGeneration();
    setIsStreaming(false);
    setActivePlan((prev) => (prev ? { ...prev, status: 'paused' } : null));
    setMessages((prev) =>
      prev.map((m) =>
        m.isStreaming
          ? {
              ...m,
              isStreaming: false,
              content: (m.content || '') + '\n\n*(Generation stopped by user)*',
            }
          : m
      )
    );
    showSuccessToast('AI generation stopped');
  };

  // Interrupt Generation or on-screen execution with updated instructions
  const handleInterrupt = async (updateMessage?: string) => {
    // Case 1: Autonomous loop is actively executing and user typed guidance:
    // Do NOT abort! Queue it so the LLM incorporates it on its next atomic step!
    if (isStreaming && updateMessage?.trim()) {
      pendingUserGuidanceRef.current.push(updateMessage.trim());

      const userGuidanceMsgId = `guidance-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        {
          id: userGuidanceMsgId,
          role: 'user',
          content: `⚡ **[Instruction for Next Step]**\n${updateMessage.trim()}`,
          timestamp: Date.now(),
          isInterruption: true,
        },
      ]);

      showSuccessToast('Instruction queued! The LLM will incorporate it in the next step.');
      return;
    }

    // Case 2: User clicked Pause (empty updateMessage) while streaming
    if (isStreaming && !updateMessage?.trim()) {
      isAutonomousLoopPausedRef.current = true;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      await stopAgentGeneration();
      setIsStreaming(false);
      setIsQueueRunning(false);
      setIsQueuePaused(true);
      setActivePlan((prev) => (prev ? { ...prev, status: 'paused' } : null));
      showInfoToast('Execution paused. Click Proceed or type in chat to continue.');
      return;
    }

    // Case 3: System was already paused and user sent input
    if (!isStreaming && updateMessage?.trim()) {
      const trimmed = updateMessage.trim();
      if (/^(proceed|continue|next|go|yes|run|ok|start)\b/i.test(trimmed)) {
        await handleProceedNextPhase();
        return;
      } else {
        pendingUserGuidanceRef.current.push(trimmed);
        const userGuidanceMsgId = `guidance-${Date.now()}`;
        setMessages((prev) => [
          ...prev,
          {
            id: userGuidanceMsgId,
            role: 'user',
            content: `⚡ **[Instruction for Next Step]**\n${trimmed}`,
            timestamp: Date.now(),
            isInterruption: true,
          },
        ]);
        await handleProceedNextPhase();
        return;
      }
    }
  };

  // Sequentially execute an array of bash commands live on screen
  const handleRunCommandsOnScreen = async (commands: string[], initialCwd?: string) => {
    if (!commands || commands.length === 0) return;
    setActiveDockTab('runner');
    setBottomDockHeight((prev) => Math.max(prev, 280));
    setIsQueueRunning(true);
    setIsQueuePaused(false);

    const targetCwd = initialCwd || currentCwd;
    const items: LiveCommandQueueItem[] = commands.map((cmd, idx) => ({
      id: `cmd-${Date.now()}-${idx}`,
      command: cmd,
      status: idx === 0 ? 'running' : 'pending',
      cwd: targetCwd,
      stdout: '',
      stderr: '',
    }));

    setLiveQueue(items);
    setCurrentQueueIndex(0);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      await streamSequentialCommandsLive(
        {
          commands,
          workspacePath,
          initialCwd: targetCwd,
          model: selectedModel,
        },
        {
          onStdout: (data) => {
            setLiveQueue((prev) =>
              prev.map((it, idx) =>
                idx === data.index
                  ? { ...it, stdout: it.stdout + data.chunk }
                  : it
              )
            );
          },
          onStderr: (data) => {
            setLiveQueue((prev) =>
              prev.map((it, idx) =>
                idx === data.index
                  ? { ...it, stderr: it.stderr + data.chunk }
                  : it
              )
            );
          },
          onCommandFinished: (data) => {
            setLiveQueue((prev) =>
              prev.map((it, idx) => {
                if (idx === data.index) {
                  return {
                    ...it,
                    status: data.success ? 'completed' : 'error',
                    exitCode: data.exitCode,
                  };
                }
                if (idx === data.index + 1 && it.status === 'pending') {
                  return { ...it, status: 'running' };
                }
                return it;
              })
            );
            setCurrentQueueIndex((prev) => Math.min(prev + 1, commands.length - 1));
          },
          onCommandAudited: (data) => {
            setLiveQueue((prev) =>
              prev.map((it, idx) => (idx === data.index ? { ...it, audit: data.audit } : it))
            );
            if (data.audit.relativeCwd && data.audit.relativeCwd !== '.') {
              showSuccessToast(`CWD shifted into ./${data.audit.relativeCwd}`);
            }
          },
          onCwdChanged: (data) => {
            setCurrentCwd(data.newCwd);
            localStorage.setItem('ide_active_cwd', data.newCwd);
            loadWorkspace();
          },
          onQueueCompleted: () => {
            setIsQueueRunning(false);
            loadWorkspace();
          },
        },
        controller.signal
      );
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        showErrorAlert('Command Queue Error', err.message);
      }
    } finally {
      setIsQueueRunning(false);
    }
  };

  // Keyboard shortcut: Escape key triggers stop generation prompt
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isStreaming) {
        handleStopGeneration();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isStreaming]);

  // Helper to stream a prompt from the backend agent
  const streamAgentTask = async (
    targetPrompt: string,
    targetMsgId: string,
    options: {
      thinkingEnabled: boolean;
      autoApplyFiles?: boolean;
      autoExecuteCommands?: boolean;
      targetFiles?: string[];
      expectedCommands?: string[];
      onFileWritten?: (file: { path: string; fullPath: string; size: number }) => void;
      onCommandExecuted?: (cmd: { command: string; success: boolean; exitCode: number; stdout: string; stderr: string; hasError: boolean }) => void;
    }
  ): Promise<{
    totalContent: string;
    writtenFiles: { path: string; fullPath: string; size: number }[];
    executedCommands: { command: string; success: boolean; exitCode: number; stdout: string; stderr: string; hasError: boolean }[];
  }> => {
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const response = await fetch('http://localhost:3001/api/agent/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: selectedModel,
        prompt: targetPrompt,
        workspacePath,
        currentCwd,
        thinkingEnabled: options.thinkingEnabled,
        autoApplyFiles: options.autoApplyFiles ?? true,
        autoExecuteCommands: options.autoExecuteCommands ?? true,
        targetFiles: options.targetFiles || [],
        activeFile: (() => {
          const tab = tabs.find((t) => t.id === activeTabId);
          return tab ? { path: tab.path, content: tab.content } : undefined;
        })(),
        openTabs: tabs.map((t) => ({ path: t.path, name: t.name })),
        conversationHistory: getCleanConversationHistory(),
      }),
    });

    if (!response.body) throw new Error('No streaming response body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalContent = '';
    const writtenFiles: { path: string; fullPath: string; size: number }[] = [];
    const executedCommands: { command: string; success: boolean; exitCode: number; stdout: string; stderr: string; hasError: boolean }[] = [];

    while (true) {
      if (controller.signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';

      for (const ev of events) {
        if (!ev.trim() || controller.signal.aborted) continue;
        const lines = ev.split('\n');
        let eventType = 'message';
        let dataStr = '';

        for (const line of lines) {
          if (line.startsWith('event: ')) eventType = line.substring(7);
          if (line.startsWith('data: ')) dataStr = line.substring(6);
        }

        if (eventType === 'chunk' && dataStr) {
          try {
            const data = JSON.parse(dataStr);
            totalContent += data.chunk || '';
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== targetMsgId) return m;
                if (data.isThinking) {
                  return { ...m, thinking: (m.thinking || '') + data.chunk };
                } else {
                  return { ...m, content: m.content + data.chunk };
                }
              })
            );
          } catch (e) {}
        } else if (eventType === 'error' && dataStr) {
          try {
            const errData = JSON.parse(dataStr);
            const errMsg = errData.error || 'Execution error from local LLM stream';
            console.error('Agent stream error event:', errMsg);
            setMessages((prev) =>
              prev.map((m) =>
                m.id === targetMsgId
                  ? {
                      ...m,
                      content: (m.content ? m.content + '\n\n' : '') + `❌ **Error:** ${errMsg}`,
                      isStreaming: false,
                    }
                  : m
              )
            );
            showErrorAlert('Agent Execution Error', errMsg);
            throw new Error(errMsg);
          } catch (e: any) {
            throw e;
          }
        } else if (eventType === 'file_written' && dataStr) {
          try {
            const f = JSON.parse(dataStr);
            fileDiffHistoryRef.current[f.path] = {
              originalContent: f.originalContent ?? '',
              modifiedContent: f.content ?? '',
            };
            fileDiffHistoryRef.current[f.fullPath] = fileDiffHistoryRef.current[f.path];
            writtenFiles.push(f);
            options.onFileWritten?.(f);
          } catch (e) {}
        } else if (eventType === 'command_started' && dataStr) {
          try {
            const cs = JSON.parse(dataStr);
            setActiveDockTab('runner');
            setBottomDockHeight((prev) => Math.max(prev, 280));
            setIsQueueRunning(true);
            setIsQueuePaused(false);
            setLiveQueue((prev) => {
              const itemExists = prev.find((p) => p.command === cs.command && p.status === 'running');
              if (itemExists) return prev;
              return [
                ...prev,
                {
                  id: `cmd-${Date.now()}`,
                  command: cs.command,
                  status: 'running',
                  cwd: cs.cwd || currentCwd,
                  stdout: '',
                  stderr: '',
                },
              ];
            });
          } catch (e) {}
        } else if (eventType === 'command_stdout' && dataStr) {
          try {
            const co = JSON.parse(dataStr);
            setLiveQueue((prev) =>
              prev.map((item) =>
                item.command === co.command && item.status === 'running'
                  ? { ...item, stdout: item.stdout + co.chunk }
                  : item
              )
            );
          } catch (e) {}
        } else if (eventType === 'command_stderr' && dataStr) {
          try {
            const ce = JSON.parse(dataStr);
            setLiveQueue((prev) =>
              prev.map((item) =>
                item.command === ce.command && item.status === 'running'
                  ? { ...item, stderr: item.stderr + ce.chunk }
                  : item
              )
            );
          } catch (e) {}
        } else if (eventType === 'command_audited' && dataStr) {
          try {
            const ca = JSON.parse(dataStr);
            setLiveQueue((prev) =>
              prev.map((item) =>
                item.command === ca.command
                  ? { ...item, audit: ca, status: ca.success ? 'completed' : 'error' }
                  : item
              )
            );
            setMessages((prev) =>
              prev.map((m) =>
                m.id === targetMsgId
                  ? { ...m, commandAudit: ca }
                  : m
              )
            );
          } catch (e) {}
        } else if (eventType === 'cwd_changed' && dataStr) {
          try {
            const cd = JSON.parse(dataStr);
            setCurrentCwd(cd.newCwd);
            localStorage.setItem('ide_active_cwd', cd.newCwd);
            loadWorkspace();
            showSuccessToast(`CWD shifted to ./${cd.relativeCwd}`);
          } catch (e) {}
        } else if (eventType === 'command_executed' && dataStr) {
          try {
            const c = JSON.parse(dataStr);
            executedCommands.push(c);
            options.onCommandExecuted?.(c);
            setIsQueueRunning(false);
          } catch (e) {}
        } else if (eventType === 'done' && dataStr) {
          try {
            const d = JSON.parse(dataStr);
            if (d.writtenFiles) {
              for (const wf of d.writtenFiles) {
                if (!writtenFiles.some((w) => w.path === wf.relPath || w.path === wf.path)) {
                  writtenFiles.push(wf);
                  options.onFileWritten?.(wf);
                }
              }
            }
          } catch (e) {}
        }
      }
    }

    return { totalContent, writtenFiles, executedCommands };
  };

  // Autonomous Verification & Error-Checking on workspace files
  const runFinalVerification = async () => {
    try {
      const treeRes = await fetchFileTree(workspacePath);
      const workspaceFileNames = treeRes.tree
        .filter((f) => !f.isDirectory && f.name !== 'IMPLEMENTATION_PLAN.md')
        .map((f) => f.name);

      if (workspaceFileNames.length > 0) {
        const verifyRes = await verifyWorkspaceFiles({
          workspacePath,
          files: workspaceFileNames,
        });

        if (verifyRes.verified) {
          showSuccessToast('All workspace files verified successfully (0 syntax errors)');
        }
      }
    } catch (vErr) {
      console.error('Verification error:', vErr);
    }
  };

  // Autonomous Step-by-Step Execution Engine
  // The LLM scans the workspace files & folders, executes ONE atomic action, rescans disk, and issues the next action
  const runAutonomousStepByStepLoop = async (
    planPrompt: string,
    planMarkdown: string,
    planTasksList: PlanTask[],
    thinkingEnabled: boolean,
    startStepIndex = 1,
    existingActions: any[] = [],
    initialLastResult: any = null,
    passedConversationHistory?: { role: string; content: string }[]
  ) => {
    if (!selectedModel) {
      await showWarningAlert('Model Required', 'Please select a local AI model before executing.');
      setIsModelModalOpen(true);
      return;
    }

    if (isModelBooting) {
      showInfoToast(`Please wait: ${selectedModel} is currently booting into RAM. Execution will automatically start once online.`);
      return;
    }

    const isModelResident = activeLoadedModels.some((m) => m.name === selectedModel);
    if (!isModelResident) {
      const booted = await runModelBootSequence(selectedModel, true);
      if (!booted) {
        showErrorAlert('Boot Error', `Cannot start execution because ${selectedModel} failed to boot into memory.`);
        return;
      }
    }

    isAutonomousLoopPausedRef.current = false;
    setIsStreaming(true);

    const completedActions = [...existingActions];
    let lastActionResult = initialLastResult;
    let stepIndex = startStepIndex;
    const maxSteps = 30;
    const convHistory = passedConversationHistory || getCleanConversationHistory();

    activeAutonomousTaskRef.current = {
      prompt: planPrompt,
      planMarkdown,
      planTasks: planTasksList,
      stepIndex,
      completedActions,
      lastActionResult,
      thinkingEnabled,
      conversationHistory: convHistory,
    };

    try {
      while (stepIndex <= maxSteps) {
        if (isAutonomousLoopPausedRef.current) break;
        if (abortControllerRef.current?.signal.aborted) break;

        // Drain pending user instructions queued while agent was working
        const currentGuidance = [...pendingUserGuidanceRef.current];
        pendingUserGuidanceRef.current = [];

        const stepMsgId = `step-${stepIndex}-${Date.now()}`;
        const guidanceSnippetText =
          currentGuidance.length > 0
            ? `\n\n⚡ *Incorporating user instruction:* ${currentGuidance.map((g) => `"${g}"`).join('; ')}`
            : '';

        setMessages((prev) => [
          ...prev,
          {
            id: stepMsgId,
            role: 'assistant',
            content: `🔍 **Step ${stepIndex}: Scanning workspace files & determining next action...**${guidanceSnippetText}`,
            thinking: '',
            isStreaming: true,
            timestamp: Date.now(),
          },
        ]);

        const stepController = new AbortController();
        abortControllerRef.current = stepController;

        const stepResult = await executeAgentStep(
          {
            model: selectedModel,
            planPrompt,
            planMarkdown,
            stepIndex,
            completedActions,
            lastActionResult,
            additionalUserGuidance: currentGuidance,
            workspacePath,
            currentCwd,
            thinkingEnabled,
            conversationHistory: convHistory,
          },
          {
            onChunk: (chunk, isThinking) => {
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== stepMsgId) return m;
                  if (isThinking) {
                    return { ...m, thinking: (m.thinking || '') + chunk };
                  }
                  return { ...m, content: (m.content || '') + chunk };
                })
              );
            },
            onFileWritten: async (file) => {
              await loadWorkspace();
              handleSelectFile(file.fullPath);
              showSuccessToast(`Created/Updated ${file.path}`);
            },
            onCommandStarted: (cmd) => {
              setActiveDockTab('runner');
              setIsQueueRunning(true);
              setIsQueuePaused(false);
              const queueItem: LiveCommandQueueItem = {
                id: `cmd-${Date.now()}`,
                command: cmd.command,
                status: 'running',
                cwd: cmd.cwd,
                stdout: '',
                stderr: '',
                startTime: Date.now(),
              };
              setLiveQueue((prev) => [...prev, queueItem]);
              setCurrentQueueIndex((prev) => prev + 1);
            },
            onStdout: (chunk) => {
              setLiveQueue((prev) => {
                if (prev.length === 0) return prev;
                const updated = [...prev];
                const last = { ...updated[updated.length - 1] };
                last.stdout += chunk;
                updated[updated.length - 1] = last;
                return updated;
              });
            },
            onStderr: (chunk) => {
              setLiveQueue((prev) => {
                if (prev.length === 0) return prev;
                const updated = [...prev];
                const last = { ...updated[updated.length - 1] };
                last.stderr += chunk;
                updated[updated.length - 1] = last;
                return updated;
              });
            },
            onCommandFinished: (res) => {
              setLiveQueue((prev) => {
                if (prev.length === 0) return prev;
                const updated = [...prev];
                const last = { ...updated[updated.length - 1] };
                last.exitCode = res.exitCode;
                last.status = res.success ? 'completed' : 'error';
                last.endTime = Date.now();
                updated[updated.length - 1] = last;
                return updated;
              });
              if (res.success) {
                showSuccessToast(`Finished: ${res.command}`);
              } else {
                showWarningAlert('Command Alert', `Command returned exit code ${res.exitCode}`);
              }
            },
            onCommandAudited: (audit) => {
              setLiveQueue((prev) => {
                if (prev.length === 0) return prev;
                const updated = [...prev];
                const last = { ...updated[updated.length - 1] };
                last.audit = audit;
                updated[updated.length - 1] = last;
                return updated;
              });
            },
            onCwdChanged: (cwd) => {
              setCurrentCwd(cwd.newCwd);
              showInfoToast(`Working directory changed: ${cwd.relativeCwd || cwd.newCwd}`);
            },
            onStepCompleted: (step) => {
              setPlanTasks((prev) => {
                const nextIncompleteIdx = prev.findIndex((t) => !t.completed);
                if (nextIncompleteIdx !== -1 && (step.actionType === 'file_written' || step.actionType === 'command' || step.actionType === 'plan_complete')) {
                  return prev.map((t, i) => (i === nextIncompleteIdx ? { ...t, completed: true } : t));
                }
                return prev;
              });
            },
            onError: (err) => {
              showErrorAlert('Step Execution Error', err);
            },
          },
          stepController.signal
        );

        if (isAutonomousLoopPausedRef.current || stepController.signal.aborted) {
          break;
        }

        completedActions.push({
          step: stepIndex,
          type: stepResult.actionType,
          summary: stepResult.summary,
          actionResult: stepResult.actionResult,
        });
        lastActionResult = stepResult.actionResult || { type: stepResult.actionType, success: true };

        setMessages((prev) =>
          prev.map((m) =>
            m.id === stepMsgId
              ? {
                  ...m,
                  content:
                    stepResult.isFinished
                      ? `🎉 **Implementation Completed & Verified!**\n\n${stepResult.summary}\n\n${stepResult.explanation || ''}`
                      : `✅ **Step ${stepIndex} (${stepResult.actionType}):** ${stepResult.summary}\n\n${stepResult.explanation || ''}`,
                  isStreaming: false,
                }
              : m
          )
        );

        if (activeAutonomousTaskRef.current) {
          activeAutonomousTaskRef.current.stepIndex = stepIndex + 1;
          activeAutonomousTaskRef.current.completedActions = completedActions;
          activeAutonomousTaskRef.current.lastActionResult = lastActionResult;
        }

        if (stepResult.isFinished) {
          showSuccessToast('All implementation steps completed and verified!');
          setPlanTasks((prev) => prev.map((t) => ({ ...t, completed: true })));
          setActivePlan((prev) => (prev ? { ...prev, status: 'completed' } : null));
          await runFinalVerification();
          break;
        }

        stepIndex++;
        await new Promise((r) => setTimeout(r, 600));
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        showErrorAlert('Autonomous Loop Error', err.message || String(err));
      }
    } finally {
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
  };

  // Helper to execute an individual phase of an active plan
  const executePhase = async (
    plan: ActivePlanExecution,
    phaseIndex: number,
    thinkingEnabled: boolean
  ) => {
    if (abortControllerRef.current?.signal.aborted) return;

    // Requirement 2: Prompt user if model has not been selected
    if (!selectedModel) {
      await showWarningAlert('Model Required', 'Please select a local AI model before executing plan phases.');
      setIsModelModalOpen(true);
      return;
    }

    // Requirement 3: If model is currently launching, do not proceed with execution
    if (isModelBooting) {
      showInfoToast(`Please wait: ${selectedModel} is currently booting into RAM. Execution will automatically start once online.`);
      return;
    }

    // Requirement 2: If LLM is not fully booted up, do not start execution; boot it first
    const isModelResident = activeLoadedModels.some((m) => m.name === selectedModel);
    if (!isModelResident) {
      const booted = await runModelBootSequence(selectedModel, true);
      if (!booted) {
        showErrorAlert('Boot Error', `Cannot start Phase ${plan.phases[phaseIndex]?.number || 1} because ${selectedModel} failed to boot into memory.`);
        return;
      }
    }

    if (phaseIndex >= plan.phases.length) {
      setActivePlan({ ...plan, status: 'completed' });
      await runFinalVerification();
      return;
    }

    const phase = plan.phases[phaseIndex];
    const phaseMsgId = `phase-${phase.number}-${Date.now()}`;

    setMessages((prev) => [
      ...prev,
      {
        id: phaseMsgId,
        role: 'assistant',
        content: `🚀 **Phase ${phase.number}/${plan.phases.length}: ${phase.title}**\n\n*Target Files:* ${phase.targetFiles.join(', ') || 'Auto-detected'}\n*Commands:* ${phase.commands.join(', ') || 'Auto-detected'}\n\n`,
        thinking: '',
        isStreaming: true,
        timestamp: Date.now(),
      },
    ]);

    const phasePrompt = `You are executing Phase ${phase.number}/${plan.phases.length}: "${phase.title}" for: "${plan.prompt}".

OBJECTIVE & DETAILS:
${phase.description}

TARGET FILES TO CREATE:
${phase.targetFiles.length > 0 ? phase.targetFiles.map((f) => `- ${f}`).join('\n') : 'Create necessary project files'}

COMMANDS TO RUN:
${phase.commands.length > 0 ? phase.commands.map((c) => `- ${c}`).join('\n') : 'None'}

MANDATORY INSTRUCTIONS:
1. Provide the complete code for EVERY target file. Do NOT write placeholders, summaries, or omissions.
2. Put the code for each file inside a markdown code block:
\`\`\`file:path/to/file.ext
[complete code here]
\`\`\`
3. If terminal commands are needed (e.g. npm init, npm install), provide them inside:
\`\`\`bash
command to execute
\`\`\`
4. The system will automatically execute all commands and write all files directly to disk.
Write the complete code for the files now:`;

    try {
      const phaseResult = await streamAgentTask(phasePrompt, phaseMsgId, {
        thinkingEnabled,
        targetFiles: phase.targetFiles,
        expectedCommands: phase.commands,
        autoExecuteCommands: true,
        autoApplyFiles: true,
        onFileWritten: (file) => {
          loadWorkspace();
          handleSelectFile(file.fullPath);
          showSuccessToast(`Created/Updated ${file.path}`);
        },
        onCommandExecuted: async (cmd) => {
          if (cmd.hasError) {
            showWarningAlert('Command Error', `Command "${cmd.command}" failed.`);
          } else {
            showSuccessToast(`Ran: ${cmd.command}`);
          }
        },
      });

      // Autonomous Targeted Fallback: verify every planned targetFile was created/written
      if (!abortControllerRef.current?.signal.aborted) {
        const writtenRelPaths = new Set(
          phaseResult.writtenFiles.map((w) => w.path.replace(/^(\.\/|\/)/, '').toLowerCase())
        );

        const missingFiles = phase.targetFiles.filter((tf) => {
          const clean = tf.replace(/^(\.\/|\/)/, '').trim().toLowerCase();
          return !writtenRelPaths.has(clean) && !Array.from(writtenRelPaths).some((wp) => wp.endsWith('/' + clean));
        });

        if (missingFiles.length > 0) {
          for (const missingFile of missingFiles) {
            if (abortControllerRef.current?.signal.aborted) break;
            const fallbackMsgId = `fallback-${Date.now()}-${missingFile.replace(/[^a-zA-Z0-9]/g, '_')}`;

            setMessages((prev) => [
              ...prev,
              {
                id: fallbackMsgId,
                role: 'assistant',
                content: `✍️ **Generating missing target file:** \`${missingFile}\`...`,
                thinking: '',
                isStreaming: true,
                timestamp: Date.now(),
              },
            ]);

            const singleFilePrompt = `You are implementing Phase ${phase.number} (${phase.title}) of "${plan.prompt}".
Generate the complete, working production code for the file: "${missingFile}".
Do NOT write conversational filler or instructions.
Output ONLY the file code inside:
\`\`\`file:${missingFile}
[complete code here]
\`\`\``;

            try {
              const fallbackRes = await streamAgentTask(singleFilePrompt, fallbackMsgId, {
                thinkingEnabled: false,
                targetFiles: [missingFile],
                autoApplyFiles: true,
                autoExecuteCommands: false,
                onFileWritten: (file) => {
                  loadWorkspace();
                  handleSelectFile(file.fullPath);
                  showSuccessToast(`Created ${file.path}`);
                },
              });

              if (fallbackRes.writtenFiles.length > 0) {
                for (const wf of fallbackRes.writtenFiles) {
                  if (!phaseResult.writtenFiles.some((p) => p.path === wf.path)) {
                    phaseResult.writtenFiles.push(wf);
                  }
                }
              }
            } catch (fbErr) {
              console.warn(`Fallback generation for ${missingFile} failed:`, fbErr);
            }
          }
        }
      }

      // Mark checklist tasks completed for this phase
      setPlanTasks((prev) =>
        prev.map((t, idx) => {
          if (idx < (phaseIndex + 1) * Math.ceil(prev.length / plan.phases.length)) {
            return { ...t, completed: true };
          }
          return t;
        })
      );

      const isLastPhase = phaseIndex === plan.phases.length - 1;
      const filesCount = phaseResult.writtenFiles.length;
      const cmdsCount = phaseResult.executedCommands.length;
      const hadMissingTargets = phase.targetFiles.length > 0 && filesCount === 0;

      setMessages((prev) =>
        prev.map((m) =>
          m.id === phaseMsgId
            ? {
                ...m,
                content:
                  m.content +
                  (hadMissingTargets
                    ? `\n\n⚠️ **Phase ${phase.number} Completed with Warnings:** (0 files written for planned targets: ${phase.targetFiles.join(', ')}, ${cmdsCount} commands run)`
                    : `\n\n✅ **Phase ${phase.number} Complete!** (${filesCount} files written, ${cmdsCount} commands run)`) +
                  (isLastPhase
                    ? '\n\n🎉 **All phases have been executed!** Running final workspace verification...'
                    : `\n\n⏸️ **System Paused.** Local LLM taking a breather to keep memory and CPU cool.\n*Ready for Phase ${phase.number + 1}: ${plan.phases[phaseIndex + 1]?.title || 'Next Phase'}? Click **Proceed to Phase ${phase.number + 1}** above or type in chat to continue.*`),
                isStreaming: false,
              }
            : m
        )
      );

      if (isLastPhase) {
        setActivePlan({ ...plan, status: 'completed' });
        showSuccessToast('All implementation plan phases completed!');
        await runFinalVerification();
      } else {
        // PAUSE HERE as requested: LLM takes a breather and waits for user confirmation
        const updatedPlan: ActivePlanExecution = {
          ...plan,
          currentPhaseIndex: phaseIndex + 1,
          status: 'paused',
        };
        setActivePlan(updatedPlan);
        showSuccessToast(`Phase ${phase.number} complete. System paused for review.`);
      }
    } catch (err: any) {
      setActivePlan((prev) => (prev ? { ...prev, status: 'error' } : null));
      showErrorAlert('Phase Execution Error', err.message || 'Error occurred');
    } finally {
      setIsStreaming(false);
    }
  };

  // User proceeds to next phase or resumes autonomous step loop
  const handleProceedNextPhase = async () => {
    if (activeAutonomousTaskRef.current) {
      const task = activeAutonomousTaskRef.current;
      showSuccessToast(`Resuming Step ${task.stepIndex}...`);
      setActivePlan((prev) => (prev ? { ...prev, status: 'executing' } : null));
      await runAutonomousStepByStepLoop(
        task.prompt,
        task.planMarkdown,
        task.planTasks,
        task.thinkingEnabled,
        task.stepIndex,
        task.completedActions,
        task.lastActionResult,
        task.conversationHistory
      );
      return;
    }
    if (!activePlan || activePlan.status !== 'paused') return;
    const nextIdx = activePlan.currentPhaseIndex;
    if (nextIdx >= activePlan.phases.length) return;

    const nextPhase = activePlan.phases[nextIdx];
    showSuccessToast(`Resuming: Starting Phase ${nextPhase.number}...`);

    setActivePlan({ ...activePlan, status: 'executing' });
    setIsStreaming(true);

    // Give a brief 800ms breather cooldown for memory garbage collection
    await new Promise((r) => setTimeout(r, 800));

    await executePhase(activePlan, nextIdx, true);
  };

  // User skips a phase or step
  const handleSkipPhase = () => {
    if (activeAutonomousTaskRef.current) {
      activeAutonomousTaskRef.current.stepIndex += 1;
      showSuccessToast(`Skipped to Step ${activeAutonomousTaskRef.current.stepIndex}`);
      return;
    }
    if (!activePlan) return;
    const nextIdx = activePlan.currentPhaseIndex + 1;
    if (nextIdx >= activePlan.phases.length) {
      setActivePlan({ ...activePlan, status: 'completed' });
      showSuccessToast('Plan finished (remaining phases skipped)');
    } else {
      setActivePlan({ ...activePlan, currentPhaseIndex: nextIdx, status: 'paused' });
      showSuccessToast(`Skipped to Phase ${activePlan.phases[nextIdx].number}`);
    }
  };

  // Agent Chat Streaming Handler: Autonomous Phased Pipeline
  const handleSendMessage = async (
    prompt: string,
    options: { thinkingEnabled: boolean; mode: 'chat' | 'plan' }
  ) => {
    // If agent is actively streaming / executing, queue this message as guidance for the next step!
    if (isStreaming) {
      await handleInterrupt(prompt);
      return;
    }

    if (!selectedModel) {
      await showWarningAlert('Model Required', 'Please select a local AI model from the top model selector first.');
      setIsModelModalOpen(true);
      return;
    }

    // Requirement 3: If model is currently launching, do not proceed with execution
    if (isModelBooting) {
      showInfoToast(`Please wait: Model "${selectedModel}" is currently booting into RAM. Execution will automatically begin once online.`);
      return;
    }

    // Requirement 2: If LLM is not fully booted up, do not start execution; boot it first
    const isModelResident = activeLoadedModels.some((m) => m.name === selectedModel);
    if (!isModelResident) {
      const bootNoticeId = `boot-notice-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        {
          id: bootNoticeId,
          role: 'assistant',
          content: `⏳ **Please wait as model is being booted:** Local LLM \`${selectedModel}\` is dormant on disk and is waking up into RAM.\n*Execution of your request has not started yet and will automatically begin once the engine is online.*`,
          timestamp: Date.now(),
        },
      ]);

      const booted = await runModelBootSequence(selectedModel, true);
      setMessages((prev) => prev.filter((m) => m.id !== bootNoticeId));

      if (!booted) {
        return;
      }
    }

    // Check if system is currently paused or interrupted and user inputs input
    if (activePlan && (activePlan.status === 'paused' || activePlan.status === 'interrupted')) {
      const trimmed = prompt.trim();
      if (/^(proceed|continue|next|go|yes|run|ok|start)\b/i.test(trimmed)) {
        const userMsg: ChatMessage = {
          id: `msg-${Date.now()}`,
          role: 'user',
          content: prompt,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, userMsg]);
        await handleProceedNextPhase();
        return;
      } else {
        // User typed new information/requirements while paused!
        await handleInterrupt(prompt);
        return;
      }
    }

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    };
    messagesRef.current = [...messagesRef.current, userMsg];
    setMessages((prev) => [...prev, userMsg]);
    setIsStreaming(true);

    const historyForLlm = getCleanConversationHistory();

    try {
      // =========================================================================
      // STEP 1: LAYER OF INTERPRETATION (Determine what the user intends before implementation)
      // =========================================================================
      const interpretMsgId = `interpret-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        {
          id: interpretMsgId,
          role: 'assistant',
          content: '🧠 **Analyzing project context & interpreting intent...**',
          isStreaming: true,
          timestamp: Date.now(),
        },
      ]);

      const interpretationResult = await interpretUserIntent({
        model: selectedModel,
        prompt,
        workspacePath,
        currentCwd,
        conversationHistory: historyForLlm,
      });

      const interpretation = interpretationResult.interpretation;

      // Update interpretation message with the structured card
      setMessages((prev) =>
        prev.map((m) =>
          m.id === interpretMsgId
            ? {
                ...m,
                content: '',
                intentInterpretation: interpretation,
                isStreaming: false,
              }
            : m
        )
      );

      if (abortControllerRef.current?.signal.aborted) return;

      const isActionable =
        options.mode === 'plan' ||
        interpretation.isActionable ||
        ['implementation', 'modification', 'bugfix'].includes(interpretation.intentType);

      if (!isActionable) {
        // Conversational, investigative, or conceptual query
        const assistantMsgId = `asst-${Date.now()}`;
        setMessages((prev) => [
          ...prev,
          {
            id: assistantMsgId,
            role: 'assistant',
            content: '',
            thinking: '',
            isStreaming: true,
            timestamp: Date.now(),
          },
        ]);

        await streamAgentTask(prompt, assistantMsgId, {
          thinkingEnabled: options.thinkingEnabled,
          autoApplyFiles: false,
          autoExecuteCommands: false,
        });

        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMsgId ? { ...m, isStreaming: false } : m))
        );
      } else {
        // =========================================================================
        // STEP 2: AUTONOMOUS STEP-BY-STEP IMPLEMENTATION PIPELINE
        // =========================================================================
        // Prompt LLM to break task into detailed plan & write out on Monaco
        const planMsgId = `plan-msg-${Date.now()}`;
        setMessages((prev) => [
          ...prev,
          {
            id: planMsgId,
            role: 'assistant',
            content: '📋 **Analyzing requirements and generating Implementation Plan...**',
            isStreaming: true,
            timestamp: Date.now(),
          },
        ]);

        const planResult = await generateImplementationPlan({
          model: selectedModel,
          prompt,
          workspacePath,
          interpretation,
          conversationHistory: historyForLlm,
        });

        if (abortControllerRef.current?.signal.aborted) return;

        // Write out on Monaco Editor!
        await loadWorkspace();
        await handleSelectFile(planResult.planFilePath, planResult.planMarkdown);

        // Update Plan Drawer tasks
        setPlanTasks(planResult.tasks);
        setActiveDockTab('plan');

        setMessages((prev) =>
          prev.map((m) =>
            m.id === planMsgId
              ? {
                  ...m,
                  content: `📋 **Implementation Plan generated!**\n\nThe plan has been written to \`IMPLEMENTATION_PLAN.md\` and opened in Monaco Editor.\n\n${planResult.planMarkdown}\n\n---\n*Starting Step-by-Step Autonomous Execution... The LLM will inspect files and issue commands/edits step by step.*`,
                  isStreaming: false,
                }
              : m
          )
        );

        // Step 3: Initialize activePlan state and run Step-by-Step Autonomous Execution Loop
        const newPlanState: ActivePlanExecution = {
          prompt,
          phases: planResult.phases,
          currentPhaseIndex: 0,
          status: 'executing',
          autoProceed: true,
        };
        setActivePlan(newPlanState);

        await runAutonomousStepByStepLoop(
          prompt,
          planResult.planMarkdown,
          planResult.tasks,
          options.thinkingEnabled,
          1,
          [],
          null,
          historyForLlm
        );
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setMessages((prev) => [
          ...prev,
          {
            id: `err-${Date.now()}`,
            role: 'assistant',
            content: `❌ Error: ${err.message}`,
            timestamp: Date.now(),
          },
        ]);
        showErrorAlert('Agent Error', err.message || String(err));
      }
    } finally {
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
  };

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeModelObj = models.find((m) => m.name === selectedModel);
  const activeLoadedModels = models.filter((m) => m.isLoadedInRam);
  const totalLoadedRamGB = activeLoadedModels
    .reduce((acc, m) => {
      const gb = m.loadedDetails?.ramGB ? parseFloat(m.loadedDetails.ramGB) : parseFloat(m.sizeGB);
      return acc + (isNaN(gb) ? 0 : gb);
    }, 0)
    .toFixed(2);

  return (
    <div className="ide-container">
      {/* 1. TOP HEADER */}
      <header className="ide-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div className="ide-brand">
            <div className="ide-logo-icon">
              <Code2 size={16} />
            </div>
            <span className="brand-gradient">ARIA IDE</span>
          </div>

          {/* Model Pill Button */}
          <button
            className={`model-pill-btn ${selectedModel ? 'active' : ''}`}
            onClick={() => setIsModelModalOpen(true)}
            title="Click to view installed models & RAM cost"
          >
            <Cpu size={14} color="var(--accent-cyan)" />
            <span>{selectedModel || 'Choose Local Model'}</span>
            {activeModelObj && (
              <span className={`badge ${
                activeModelObj.safetyBadge === 'SAFE'
                  ? 'badge-safe'
                  : activeModelObj.safetyBadge === 'TIGHT'
                  ? 'badge-tight'
                  : 'badge-heavy'
              }`}>
                {activeModelObj.ramEstimate.totalEstimatedGB} GB RAM
              </span>
            )}
          </button>

          {/* Live LLM Booting Status Pill */}
          {isModelBooting && (
            <div className="model-booting-pill">
              <RefreshCw size={13} style={{ animation: 'spin 1s linear infinite' }} />
              <span>Waking up {bootTargetModel || selectedModel} ({bootProgress}%)</span>
            </div>
          )}

          {/* Manual Boot Button if Model is Cold on Disk */}
          {!isModelBooting && selectedModel && !activeLoadedModels.some((m) => m.name === selectedModel) && (
            <button
              className="boot-model-header-btn"
              onClick={() => handleManualBoot(selectedModel)}
              title={`Manual Boot: Click to wake up and load "${selectedModel}" into RAM now`}
            >
              <Zap size={13} />
              <span>Boot LLM</span>
              <span className="cold-badge">Cold</span>
            </button>
          )}

          {/* Quick Active RAM Indicator & Offload */}
          {activeLoadedModels.length > 0 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: 'rgba(16, 185, 129, 0.12)',
                border: '1px solid rgba(16, 185, 129, 0.4)',
                borderRadius: 8,
                padding: '4px 10px',
                fontSize: 11,
                color: '#10b981',
              }}
              title={`${activeLoadedModels.length} model(s) resident in RAM (${totalLoadedRamGB} GB). Click to offload and free memory.`}
            >
              <span className="pulsing-green-dot" />
              <span>In RAM: <strong>{totalLoadedRamGB} GB</strong></span>
              <button
                onClick={handleQuickOffloadAll}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#f87171',
                  cursor: 'pointer',
                  padding: '2px 4px',
                  display: 'flex',
                  alignItems: 'center',
                  marginLeft: 2,
                  borderRadius: 4,
                }}
                title="Offload all models from RAM to free system memory"
              >
                <PowerOff size={12} />
              </button>
            </div>
          )}
        </div>

        {/* Workspace Path Breadcrumb & Terminal CLI Helper */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div
            onClick={handleSwitchWorkspace}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12,
              fontFamily: 'var(--font-mono)',
              background: 'rgba(255, 255, 255, 0.03)',
              padding: '4px 12px',
              borderRadius: 6,
              border: '1px solid var(--border-color)',
              cursor: 'pointer',
              maxWidth: 340,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title="Click to switch workspace folder"
          >
            <FolderOpen size={14} color="var(--accent-blue)" />
            <span style={{ color: 'var(--text-muted)' }}>{workspacePath}</span>
          </div>

          <button
            className="icon-btn"
            onClick={handleInstallCli}
            style={{
              fontSize: 11,
              padding: '4px 8px',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid var(--border-color)',
              color: 'var(--text-dim)',
              borderRadius: 6,
            }}
            title="Terminal CLI: Run 'aria .' in any folder to open Aria IDE. Click to verify/install in PATH."
          >
            <TerminalIcon size={12} color="var(--accent-cyan)" />
            <span>aria .</span>
          </button>
        </div>

        {/* Hardware RAM Meter */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {systemMemory && (
            <div className="ram-meter-container">
              <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>RAM:</span>
              <div className="ram-bar">
                <div
                  className={`ram-fill ${systemMemory.usedPercent > 80 ? 'tight' : 'safe'}`}
                  style={{ width: `${systemMemory.usedPercent}%` }}
                />
              </div>
              <span style={{ color: 'var(--text-main)', fontSize: 11 }}>
                {systemMemory.usedGB} / {systemMemory.totalGB} GB
              </span>
            </div>
          )}

          {activeTab?.isDirty && (
            <button
              className="send-btn"
              style={{ padding: '4px 10px', fontSize: 11 }}
              onClick={handleSaveActiveTab}
              title="Save file (Ctrl+S)"
            >
              <Save size={13} /> Save
            </button>
          )}
        </div>
      </header>

      {/* 2. MAIN WORKSPACE BODY */}
      <div className="ide-main-body">
        {/* Left: File Explorer */}
        <FileTree
          tree={fileTree}
          activeFilePath={activeFilePath}
          onSelectFile={handleSelectFile}
          onCreateItem={handleCreateItem}
          onDeleteItem={handleDeleteItem}
          onRenameItem={() => {}}
          onRefresh={() => loadWorkspace()}
          onSwitchWorkspace={handleSwitchWorkspace}
          currentRoot={workspacePath}
          width={leftSidebarWidth}
        />

        {/* Left Sidebar Resizer */}
        <div
          className={`ide-resizer ide-resizer-col ${dragging === 'left' ? 'resizing' : ''}`}
          onMouseDown={handleStartResizeLeft}
          onDoubleClick={() => setLeftSidebarWidth(260)}
          title="Drag to resize Explorer. Double-click to reset (260px)"
        />

        {/* Center: Monaco Editor + Bottom Dock */}
        <div className="ide-center-pane">
          {/* Tabs bar */}
          <div className="editor-tabs">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={`editor-tab ${tab.id === activeTabId ? 'active' : ''}`}
                onClick={() => {
                  setActiveTabId(tab.id);
                  setActiveFilePath(tab.path);
                }}
              >
                <span>{tab.name}</span>
                {tab.isDirty && <span className="dirty-dot" title="Unsaved changes" />}
                <button
                  className="icon-btn"
                  style={{ padding: 2, marginLeft: 4 }}
                  onClick={(e) => handleCloseTab(tab.id, e)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>

          {/* Monaco Editor Canvas */}
          <div className="editor-area">
            {activeTab ? (
              <Editor
                height="100%"
                language={activeTab.language}
                value={activeTab.content}
                theme="vs-dark"
                onChange={handleEditorChange}
                options={{
                  fontSize: 13.5,
                  fontFamily: "'JetBrains Mono', monospace",
                  fontLigatures: true,
                  minimap: { enabled: true },
                  scrollBeyondLastLine: false,
                  smoothScrolling: true,
                  cursorBlinking: 'smooth',
                  renderLineHighlight: 'all',
                  automaticLayout: true,
                }}
              />
            ) : (
              <div style={{
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-dim)',
                gap: 12,
              }}>
                <Code2 size={48} style={{ opacity: 0.3 }} />
                <p style={{ fontSize: 14 }}>Select a file from Explorer to edit or ask AI to write code</p>
                <p style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                  Active Model: <strong>{selectedModel || 'None'}</strong>
                </p>
              </div>
            )}
          </div>

          {/* Bottom Dock Resizer */}
          <div
            className={`ide-resizer ide-resizer-row ${dragging === 'bottom' ? 'resizing' : ''}`}
            onMouseDown={handleStartResizeBottom}
            onDoubleClick={() => setBottomDockHeight(240)}
            title="Drag to resize Bottom panel. Double-click to reset (240px)"
          />

          {/* Bottom Dock (Live Runner / Terminal / Implementation Plan) */}
          <div className="bottom-dock" style={{ height: `${bottomDockHeight}px` }}>
            <div className="dock-header">
              <div className="dock-tabs">
                <button
                  className={`dock-tab ${activeDockTab === 'runner' ? 'active' : ''}`}
                  onClick={() => setActiveDockTab('runner')}
                >
                  <Zap
                    size={12}
                    style={{
                      display: 'inline',
                      marginRight: 4,
                      color: isQueueRunning ? 'var(--accent-cyan)' : undefined,
                    }}
                  />
                  Live Command Runner {isQueueRunning ? '(Running...)' : liveQueue.length > 0 ? `(${liveQueue.length})` : ''}
                </button>
                <button
                  className={`dock-tab ${activeDockTab === 'terminal' ? 'active' : ''}`}
                  onClick={() => setActiveDockTab('terminal')}
                >
                  <TerminalIcon size={12} style={{ display: 'inline', marginRight: 4 }} />
                  Terminal
                </button>
                <button
                  className={`dock-tab ${activeDockTab === 'plan' ? 'active' : ''}`}
                  onClick={() => setActiveDockTab('plan')}
                >
                  <ListTodo size={12} style={{ display: 'inline', marginRight: 4 }} />
                  Implementation Plan ({planTasks.length})
                </button>
              </div>
            </div>

            <div style={{ flex: 1, overflow: 'hidden' }}>
              {activeDockTab === 'runner' ? (
                <OnScreenCommandRunner
                  queue={liveQueue}
                  currentIndex={currentQueueIndex}
                  isRunning={isQueueRunning}
                  isPaused={isQueuePaused}
                  currentCwd={currentCwd}
                  workspacePath={workspacePath}
                  onInterrupt={(msg) => handleInterrupt(msg)}
                  onResume={() => {
                    setIsQueuePaused(false);
                    setIsQueueRunning(true);
                  }}
                  onSkip={() => {
                    if (currentQueueIndex + 1 < liveQueue.length) {
                      setCurrentQueueIndex((prev) => prev + 1);
                    } else {
                      setIsQueueRunning(false);
                    }
                  }}
                  onRunCustomCommand={(cmd) => handleRunCommandsOnScreen([cmd])}
                />
              ) : activeDockTab === 'terminal' ? (
                <TerminalPane currentCwd={currentCwd} />
              ) : (
                <PlanDrawer
                  plan={planTasks}
                  onToggleTask={(id) => {
                    setPlanTasks((prev) =>
                      prev.map((t) => (t.id === id ? { ...t, completed: !t.completed } : t))
                    );
                  }}
                  isExecuting={isStreaming}
                  onExecutePlan={() => {
                    if (activeAutonomousTaskRef.current) {
                      const task = activeAutonomousTaskRef.current;
                      runAutonomousStepByStepLoop(
                        task.prompt,
                        task.planMarkdown,
                        task.planTasks,
                        task.thinkingEnabled,
                        task.stepIndex,
                        task.completedActions,
                        task.lastActionResult,
                        task.conversationHistory
                      );
                      return;
                    }
                    if (activePlan && activePlan.status === 'paused' && activePlan.currentPhaseIndex < activePlan.phases.length) {
                      executePhase(activePlan, activePlan.currentPhaseIndex, true);
                      return;
                    }
                    const incomplete = planTasks.filter((t) => !t.completed);
                    if (incomplete.length > 0) {
                      handleSendMessage(
                        `Please execute the steps from our implementation plan`,
                        { thinkingEnabled: true, mode: 'chat' }
                      );
                    }
                  }}
                />
              )}
            </div>
          </div>
        </div>

        {/* Right Sidebar Resizer */}
        <div
          className={`ide-resizer ide-resizer-col ${dragging === 'right' ? 'resizing' : ''}`}
          onMouseDown={handleStartResizeRight}
          onDoubleClick={() => setRightSidebarWidth(420)}
          title="Drag to resize AI Assistant. Double-click to reset (420px)"
        />

        {/* Right: AI Assistant & Agent Loop */}
        <AgentChatPane
          messages={messages}
          onSendMessage={handleSendMessage}
          onStopGeneration={handleStopGeneration}
          onInterrupt={handleInterrupt}
          selectedModel={selectedModel}
          isStreaming={isStreaming}
          onOpenDiffReview={(diff) => setActiveDiff(diff)}
          workspacePath={workspacePath}
          currentCwd={currentCwd}
          onApplyPlan={(newPlan) => setPlanTasks(newPlan)}
          onFileSavedOrCreated={(createdPath) => {
            loadWorkspace();
            if (createdPath) {
              handleSelectFile(createdPath);
            }
          }}
          getOriginalContent={getOriginalContent}
          activePlan={activePlan}
          onProceedNextPhase={handleProceedNextPhase}
          onSkipPhase={handleSkipPhase}
          onRunCommands={handleRunCommandsOnScreen}
          onOpenLiveRunner={() => {
            setActiveDockTab('runner');
            setBottomDockHeight((prev) => Math.max(prev, 280));
          }}
          width={rightSidebarWidth}
        />
      </div>

      {/* 3. STATUS BAR */}
      <footer className="ide-status-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent-emerald)' }}></span>
            <span>Local Engine Ready</span>
          </span>
          <span>Model: <strong>{selectedModel}</strong></span>
          {activeModelObj && <span>Est. RAM: <strong>{activeModelObj.ramEstimate.totalEstimatedGB} GB</strong></span>}

          {/* Status Bar: Live Booting indicator */}
          {isModelBooting && (
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                color: '#00f0ff',
                background: 'rgba(0, 240, 255, 0.1)',
                padding: '1px 6px',
                borderRadius: 4,
                border: '1px solid rgba(0, 240, 255, 0.3)',
              }}
            >
              <RefreshCw size={10} style={{ animation: 'spin 1s linear infinite' }} />
              <span>Waking up LLM... ({bootProgress}%)</span>
            </span>
          )}

          {/* Status Bar: Cold Model button */}
          {!isModelBooting && !activeModelObj?.isLoadedInRam && selectedModel && (
            <button
              onClick={() => handleManualBoot(selectedModel)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                color: '#fbbf24',
                background: 'rgba(245, 158, 11, 0.1)',
                padding: '1px 6px',
                borderRadius: 4,
                border: '1px solid rgba(245, 158, 11, 0.3)',
                cursor: 'pointer',
              }}
              title="Click to boot this model into RAM"
            >
              <Zap size={10} />
              <span>Cold in SSD (Click to Boot)</span>
            </button>
          )}

          {activeModelObj?.isLoadedInRam && (
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                color: '#10b981',
                background: 'rgba(16, 185, 129, 0.1)',
                padding: '1px 6px',
                borderRadius: 4,
                border: '1px solid rgba(16, 185, 129, 0.3)',
              }}
            >
              <span className="pulsing-green-dot" style={{ width: 6, height: 6 }} />
              <span>Resident in RAM ({activeModelObj.loadedDetails?.ramGB || activeModelObj.sizeGB} GB)</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleQuickOffloadAll();
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#f87171',
                  cursor: 'pointer',
                  padding: '0 2px',
                  display: 'flex',
                  alignItems: 'center',
                }}
                title="Offload from RAM"
              >
                <PowerOff size={11} />
              </button>
            </span>
          )}
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--accent-cyan)' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent-cyan)' }}></span>
            <span>Session Synced (.ide)</span>
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span>UTF-8</span>
          <span>{activeTab ? activeTab.language : 'Plain Text'}</span>
          <span>Aria IDE v0.1</span>
        </div>
      </footer>

      {/* 4. MODALS */}
      <ModelBootHUD
        isOpen={isModelBooting}
        modelName={bootTargetModel || selectedModel}
        percent={bootProgress}
        stageMessage={bootStageMessage}
        isCompleted={bootProgress === 100}
        ramEstimate={activeModelObj?.ramEstimate?.totalEstimatedGB}
        isAutonomousTrigger={isAutonomousBootTrigger}
      />

      <ModelSelectorModal
        isOpen={isModelModalOpen}
        onClose={() => setIsModelModalOpen(false)}
        models={models}
        selectedModel={selectedModel}
        onSelectModel={handleSwitchModel}
        systemMemory={systemMemory}
        onRefresh={loadModelsAndHardware}
      />

      <DiffReviewModal
        diff={activeDiff}
        onAccept={handleKeepDiff}
        onReject={() => activeDiff && handleRevertDiff(activeDiff)}
      />

      <WorkspacePickerModal
        isOpen={isWorkspaceModalOpen}
        onClose={() => setIsWorkspaceModalOpen(false)}
        currentWorkspace={workspacePath}
        onSelectWorkspace={handleSelectWorkspace}
      />

      {/* Fullscreen drag overlay during panel resize */}
      {dragging && (
        <div
          className="ide-resize-overlay"
          style={{
            cursor: dragging === 'bottom' ? 'row-resize' : 'col-resize',
          }}
        />
      )}
    </div>
  );
}

export default App;
