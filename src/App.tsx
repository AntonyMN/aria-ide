import React, { useState, useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';
import type {
  LocalModel,
  SystemMemory,
  FileNode,
  OpenTab,
  DiffProposal,
  PlanTask,
  ExecutionPhase,
  ChatMessage,
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
  verifyWorkspaceFiles,
} from './services/api';
import { FileTree } from './components/FileTree';
import { ModelSelectorModal } from './components/ModelSelectorModal';
import { TerminalPane } from './components/TerminalPane';
import { DiffReviewModal } from './components/DiffReviewModal';
import { PlanDrawer } from './components/PlanDrawer';
import { AgentChatPane } from './components/AgentChatPane';
import {
  confirmStopGeneration,
  promptText,
  confirmAction,
  showErrorAlert,
  showWarningAlert,
  showSuccessToast,
} from './services/alerts';
import {
  Cpu,
  FolderOpen,
  Save,
  Terminal as TerminalIcon,
  ListTodo,
  Layers,
  Sparkles,
  X,
  Code2,
} from 'lucide-react';

export function App() {
  // System & Model State
  const [models, setModels] = useState<LocalModel[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [systemMemory, setSystemMemory] = useState<SystemMemory | null>(null);
  const [isModelModalOpen, setIsModelModalOpen] = useState(false);

  // Workspace & File Tree State
  const [workspacePath, setWorkspacePath] = useState<string>('/home/anto/builds/ide');
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string>('');

  // Tabs & Monaco Editor State
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>('');

  // Bottom Dock State
  const [activeDockTab, setActiveDockTab] = useState<'terminal' | 'plan'>('terminal');

  // Diff Review State
  const [activeDiff, setActiveDiff] = useState<DiffProposal | null>(null);

  // Implementation Plan State
  const [planTasks, setPlanTasks] = useState<PlanTask[]>([]);

  // Agent Chat State
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);

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

      // Auto-select safest model if none selected yet
      if (!selectedModel && data.models.length > 0) {
        // Prefer a safe model like qwen2.5-coder:1.5b or first available
        const safe = data.models.find((m) => m.safetyBadge === 'SAFE') || data.models[0];
        setSelectedModel(safe.name);
      }
    } catch (err) {
      console.error('Failed to discover models:', err);
    }
  };

  const loadWorkspace = async (targetPath?: string) => {
    try {
      const path = targetPath || workspacePath;
      const res = await fetchFileTree(path);
      setFileTree(res.tree);
      setWorkspacePath(res.rootPath);
    } catch (err) {
      console.error('Failed to load file tree:', err);
    }
  };

  useEffect(() => {
    loadModelsAndHardware();
    loadWorkspace();

    // Poll memory periodically
    const interval = setInterval(async () => {
      try {
        const mem = await fetchSystemMemory();
        setSystemMemory(mem);
      } catch (e) {}
    }, 10000);

    return () => clearInterval(interval);
  }, []);

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

  // Switch workspace path with SweetAlert2
  const handleSwitchWorkspace = async () => {
    const newPath = await promptText({
      title: 'Switch Workspace Directory',
      text: 'Enter the absolute path to your project folder:',
      inputValue: workspacePath,
      placeholder: '/home/username/project',
      confirmButtonText: 'Open Workspace',
    });
    if (newPath && newPath !== workspacePath) {
      setWorkspacePath(newPath);
      loadWorkspace(newPath);
      showSuccessToast('Workspace directory updated');
    }
  };

  // Accept Diff and apply to file
  const handleAcceptDiff = async (diff: DiffProposal) => {
    const fullPath = diff.filePath.startsWith('/')
      ? diff.filePath
      : `${workspacePath}/${diff.filePath}`;
    try {
      await saveFileContent(fullPath, diff.modifiedContent);
      setActiveDiff(null);
      // Reload tab if open
      setTabs((prev) =>
        prev.map((t) =>
          t.path === fullPath
            ? {
                ...t,
                content: diff.modifiedContent,
                savedContent: diff.modifiedContent,
                isDirty: false,
              }
            : t
        )
      );
      loadWorkspace();
      handleSelectFile(fullPath);
      showSuccessToast('Changes applied successfully');
    } catch (err: any) {
      await showErrorAlert('Failed to Apply Diff', err.message || String(err));
    }
  };

  const abortControllerRef = useRef<AbortController | null>(null);

  // Stop Generation with SweetAlert2 confirmation
  const handleStopGeneration = async () => {
    if (!isStreaming) return;

    const confirmed = await confirmStopGeneration();
    if (!confirmed) {
      return; // User canceled the stop prompt; continue generating!
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    await stopAgentGeneration();
    setIsStreaming(false);
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
        thinkingEnabled: options.thinkingEnabled,
        autoApplyFiles: options.autoApplyFiles ?? true,
        autoExecuteCommands: options.autoExecuteCommands ?? true,
        conversationHistory: messages.slice(-4).map((m) => ({
          role: m.role,
          content: m.content,
        })),
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
        } else if (eventType === 'file_written' && dataStr) {
          try {
            const f = JSON.parse(dataStr);
            writtenFiles.push(f);
            options.onFileWritten?.(f);
          } catch (e) {}
        } else if (eventType === 'command_executed' && dataStr) {
          try {
            const c = JSON.parse(dataStr);
            executedCommands.push(c);
            options.onCommandExecuted?.(c);
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

  // Agent Chat Streaming Handler: Autonomous Phased Pipeline
  const handleSendMessage = async (
    prompt: string,
    options: { thinkingEnabled: boolean; mode: 'chat' | 'plan' }
  ) => {
    if (!selectedModel) {
      await showWarningAlert('Model Required', 'Please select a local AI model from the top model selector first.');
      setIsModelModalOpen(true);
      return;
    }

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setIsStreaming(true);

    const isActionable =
      options.mode === 'plan' ||
      /(\b(build|create|make|code|write|implement|scaffold|setup|develop|add|fix|refactor|install|generate)\b)/i.test(prompt);

    try {
      if (!isActionable) {
        // Standard conversational interaction
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
          onFileWritten: (file) => {
            loadWorkspace();
            handleSelectFile(file.fullPath);
            showSuccessToast(`Created ${file.path}`);
          },
        });

        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMsgId ? { ...m, isStreaming: false } : m))
        );
      } else {
        // =========================================================================
        // AUTONOMOUS MULTI-PHASED PIPELINE
        // =========================================================================
        // Step 1: Prompt LLM to break task into detailed phases & write out on Monaco
        const planMsgId = `plan-msg-${Date.now()}`;
        setMessages((prev) => [
          ...prev,
          {
            id: planMsgId,
            role: 'assistant',
            content: '📋 **Analyzing requirements and generating Phased Implementation Plan...**',
            isStreaming: true,
            timestamp: Date.now(),
          },
        ]);

        const planResult = await generateImplementationPlan({
          model: selectedModel,
          prompt,
          workspacePath,
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
                  content: `📋 **Implementation Plan generated!**\n\nThe plan has been written to \`IMPLEMENTATION_PLAN.md\` and opened in Monaco Editor.\n\n${planResult.planMarkdown}\n\n---\n*Starting phased execution queue (${planResult.phases.length} phases)...*`,
                  isStreaming: false,
                }
              : m
          )
        );

        // Step 2: Queue phases sequentially, starting from phase 1 to completion
        const allCreatedFiles: string[] = [];

        for (let i = 0; i < planResult.phases.length; i++) {
          if (abortControllerRef.current?.signal.aborted) break;

          const phase = planResult.phases[i];
          const phaseMsgId = `phase-${phase.number}-${Date.now()}`;

          setMessages((prev) => [
            ...prev,
            {
              id: phaseMsgId,
              role: 'assistant',
              content: `🚀 **Phase ${phase.number}/${planResult.phases.length}: ${phase.title}**\n\n*Target Files:* ${phase.targetFiles.join(', ') || 'Auto-detected'}\n*Commands:* ${phase.commands.join(', ') || 'Auto-detected'}\n\n`,
              thinking: '',
              isStreaming: true,
              timestamp: Date.now(),
            },
          ]);

          const phasePrompt = `We are executing Phase ${phase.number} of ${planResult.phases.length} for: "${prompt}".
PHASE TITLE: ${phase.title}

GOAL & SPECIFICATIONS:
${phase.description}

TARGET FILES TO CREATE OR UPDATE:
${phase.targetFiles.length > 0 ? phase.targetFiles.map((f) => `- ${f}`).join('\n') : 'Create or update necessary files'}

COMMANDS TO RUN:
${phase.commands.length > 0 ? phase.commands.map((c) => `- ${c}`).join('\n') : 'None or run setup/build commands'}

CRITICAL INSTRUCTIONS:
- Write the complete code for all files needed for this phase.
- Use explicit markdown code blocks:
\`\`\`file:relative/path/to/file.ext
[full complete code here]
\`\`\`
- Or call the native write_file tool.
- If commands are needed, use:
\`\`\`bash:run
command to execute
\`\`\`
- Or call the native run_terminal_command tool.
- Antigravity IDE will automatically write files to disk, sync Monaco Editor, and execute commands.`;

          const phaseResult = await streamAgentTask(phasePrompt, phaseMsgId, {
            thinkingEnabled: options.thinkingEnabled,
            onFileWritten: (file) => {
              allCreatedFiles.push(file.fullPath);
              loadWorkspace();
              handleSelectFile(file.fullPath);
              showSuccessToast(`Created/Updated ${file.path}`);
            },
            onCommandExecuted: async (cmd) => {
              // Autonomous Verification & Error-Checking Loop
              if (cmd.hasError) {
                showWarningAlert('Command Error', `Command "${cmd.command}" failed. Initiating self-correction...`);
                const fixPrompt = `Command failed during Phase ${phase.number}:
Command: ${cmd.command}
Exit code: ${cmd.exitCode}
Error: ${cmd.stderr || cmd.stdout}

Please diagnose this error and provide immediate self-correction using \`\`\`file:path or \`\`\`bash:run to resolve it.`;

                const fixMsgId = `fix-${Date.now()}`;
                setMessages((p) => [
                  ...p,
                  {
                    id: fixMsgId,
                    role: 'assistant',
                    content: `⚠️ **Self-Correction for command failure:**\n\n`,
                    isStreaming: true,
                    timestamp: Date.now(),
                  },
                ]);

                await streamAgentTask(fixPrompt, fixMsgId, {
                  thinkingEnabled: false,
                  onFileWritten: (f) => {
                    allCreatedFiles.push(f.fullPath);
                    loadWorkspace();
                    handleSelectFile(f.fullPath);
                  },
                });

                setMessages((p) =>
                  p.map((m) => (m.id === fixMsgId ? { ...m, isStreaming: false } : m))
                );
              }
            },
          });

          // Mark checklist tasks completed for this phase
          setPlanTasks((prev) =>
            prev.map((t, idx) => {
              if (idx < (i + 1) * Math.ceil(prev.length / planResult.phases.length)) {
                return { ...t, completed: true };
              }
              return t;
            })
          );

          setMessages((prev) =>
            prev.map((m) =>
              m.id === phaseMsgId
                ? {
                    ...m,
                    content:
                      m.content +
                      `\n\n✅ **Phase ${phase.number} Complete!** (${phaseResult.writtenFiles.length} files written, ${phaseResult.executedCommands.length} commands run)`,
                    isStreaming: false,
                  }
                : m
            )
          );
        }

        // Step 3: Verification & Error-Checking Loop on created files
        if (!abortControllerRef.current?.signal.aborted) {
          const treeRes = await fetchFileTree(workspacePath);
          const workspaceFileNames = treeRes.tree
            .filter((f) => !f.isDirectory && f.name !== 'IMPLEMENTATION_PLAN.md')
            .map((f) => f.name);

          if (workspaceFileNames.length > 0) {
            try {
              const verifyRes = await verifyWorkspaceFiles({
                workspacePath,
                files: workspaceFileNames,
              });

              if (!verifyRes.verified) {
                const errorFiles = verifyRes.results.filter((r) => r.hasError || !r.exists);
                const fixPrompt = `Syntax or validation errors detected in workspace files:
${errorFiles.map((e) => `- ${e.path}: ${e.error}`).join('\n')}

Please fix these syntax errors immediately. Provide corrected file content using \`\`\`file:path.`;

                const fixMsgId = `verify-fix-${Date.now()}`;
                setMessages((p) => [
                  ...p,
                  {
                    id: fixMsgId,
                    role: 'assistant',
                    content: `🛠️ **Self-Healing Syntax Errors:**\n\n`,
                    isStreaming: true,
                    timestamp: Date.now(),
                  },
                ]);

                await streamAgentTask(fixPrompt, fixMsgId, {
                  thinkingEnabled: false,
                  onFileWritten: (f) => {
                    loadWorkspace();
                    handleSelectFile(f.fullPath);
                  },
                });

                setMessages((p) =>
                  p.map((m) => (m.id === fixMsgId ? { ...m, isStreaming: false } : m))
                );
              }
            } catch (vErr) {
              console.error('Verification error:', vErr);
            }
          }

          // Final completion celebration summary
          setMessages((prev) => [
            ...prev,
            {
              id: `summary-${Date.now()}`,
              role: 'assistant',
              content: `🎉 **Implementation Completed Successfully!**\n\nAll ${planResult.phases.length} phases executed. Files have been generated, verified, and loaded into Monaco Editor.\n\n📂 Project Workspace: \`${workspacePath}\``,
              timestamp: Date.now(),
            },
          ]);

          showSuccessToast('All Phases Executed Successfully!');
        }
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

  return (
    <div className="ide-container">
      {/* 1. TOP HEADER */}
      <header className="ide-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div className="ide-brand">
            <div className="ide-logo-icon">
              <Code2 size={16} />
            </div>
            <span className="brand-gradient">ANTIGRAVITY IDE</span>
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
        </div>

        {/* Workspace Path Breadcrumb */}
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
            maxWidth: 380,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title="Click to switch workspace folder"
        >
          <FolderOpen size={14} color="var(--accent-blue)" />
          <span style={{ color: 'var(--text-muted)' }}>{workspacePath}</span>
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

          {/* Bottom Dock (Terminal / Implementation Plan) */}
          <div className="bottom-dock" style={{ height: `${bottomDockHeight}px` }}>
            <div className="dock-header">
              <div className="dock-tabs">
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
              {activeDockTab === 'terminal' ? (
                <TerminalPane currentCwd={workspacePath} />
              ) : (
                <PlanDrawer
                  plan={planTasks}
                  onToggleTask={(id) => {
                    setPlanTasks((prev) =>
                      prev.map((t) => (t.id === id ? { ...t, completed: !t.completed } : t))
                    );
                  }}
                  onExecutePlan={() => {
                    const incomplete = planTasks.filter((t) => !t.completed);
                    if (incomplete.length > 0) {
                      handleSendMessage(
                        `Please execute the next step from our plan: "${incomplete[0].title}"`,
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
          selectedModel={selectedModel}
          isStreaming={isStreaming}
          onOpenDiffReview={(diff) => setActiveDiff(diff)}
          workspacePath={workspacePath}
          onApplyPlan={(newPlan) => setPlanTasks(newPlan)}
          onFileSavedOrCreated={(createdPath) => {
            loadWorkspace();
            if (createdPath) {
              handleSelectFile(createdPath);
            }
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
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span>UTF-8</span>
          <span>{activeTab ? activeTab.language : 'Plain Text'}</span>
          <span>Antigravity IDE v0.1</span>
        </div>
      </footer>

      {/* 4. MODALS */}
      <ModelSelectorModal
        isOpen={isModelModalOpen}
        onClose={() => setIsModelModalOpen(false)}
        models={models}
        selectedModel={selectedModel}
        onSelectModel={(name) => setSelectedModel(name)}
        systemMemory={systemMemory}
        onRefresh={loadModelsAndHardware}
      />

      <DiffReviewModal
        diff={activeDiff}
        onAccept={handleAcceptDiff}
        onReject={() => setActiveDiff(null)}
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
