import React, { useState, useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';
import type {
  LocalModel,
  SystemMemory,
  FileNode,
  OpenTab,
  DiffProposal,
  PlanTask,
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
} from './services/api';
import { FileTree } from './components/FileTree';
import { ModelSelectorModal } from './components/ModelSelectorModal';
import { TerminalPane } from './components/TerminalPane';
import { DiffReviewModal } from './components/DiffReviewModal';
import { PlanDrawer } from './components/PlanDrawer';
import { AgentChatPane } from './components/AgentChatPane';
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
  const handleSelectFile = async (filePath: string) => {
    setActiveFilePath(filePath);
    const existing = tabs.find((t) => t.path === filePath);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }

    try {
      const { content } = await readFileContent(filePath);
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

      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id);
    } catch (err) {
      console.error('Failed to open file:', err);
    }
  };

  // Close editor tab
  const handleCloseTab = (tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
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
    } catch (err) {
      console.error('Failed to save file:', err);
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

  // Create file or folder
  const handleCreateItem = async (parentPath: string, isDirectory: boolean) => {
    const name = window.prompt(`Enter ${isDirectory ? 'folder' : 'file'} name:`);
    if (!name) return;
    const targetPath = `${parentPath}/${name}`;
    try {
      await createItem(targetPath, isDirectory);
      loadWorkspace();
      if (!isDirectory) {
        handleSelectFile(targetPath);
      }
    } catch (err) {
      alert(`Failed to create item: ${err}`);
    }
  };

  // Delete file or folder
  const handleDeleteItem = async (targetPath: string) => {
    if (!window.confirm(`Are you sure you want to delete ${targetPath}?`)) return;
    try {
      await deleteItem(targetPath);
      setTabs((prev) => prev.filter((t) => t.path !== targetPath));
      loadWorkspace();
    } catch (err) {
      alert(`Failed to delete: ${err}`);
    }
  };

  // Switch workspace path
  const handleSwitchWorkspace = () => {
    const newPath = window.prompt('Enter workspace directory path:', workspacePath);
    if (newPath && newPath !== workspacePath) {
      setWorkspacePath(newPath);
      loadWorkspace(newPath);
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
    } catch (err) {
      alert(`Failed to apply diff: ${err}`);
    }
  };

  const abortControllerRef = useRef<AbortController | null>(null);

  const handleStopGeneration = async () => {
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
  };

  // Keyboard shortcut: Escape key cancels active generation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isStreaming) {
        handleStopGeneration();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isStreaming]);

  // Agent Chat Streaming Handler
  const handleSendMessage = async (
    prompt: string,
    options: { thinkingEnabled: boolean; mode: 'chat' | 'plan' }
  ) => {
    if (!selectedModel) {
      alert('Please select a local model first.');
      setIsModelModalOpen(true);
      return;
    }

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    };

    const assistantMsgId = `asst-${Date.now()}`;
    const assistantMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      thinking: '',
      isStreaming: true,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setIsStreaming(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const response = await fetch('http://localhost:3001/api/agent/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: selectedModel,
          prompt,
          workspacePath,
          thinkingEnabled: options.thinkingEnabled,
          mode: options.mode,
          conversationHistory: messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      if (!response.body) throw new Error('No streaming body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

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

          if (eventType === 'chunk' && dataStr) {
            try {
              const data = JSON.parse(dataStr);
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== assistantMsgId) return m;
                  if (data.isThinking) {
                    return { ...m, thinking: (m.thinking || '') + data.chunk };
                  } else {
                    return { ...m, content: m.content + data.chunk };
                  }
                })
              );
            } catch (e) {}
          } else if (eventType === 'done' && dataStr) {
            try {
              const doneData = JSON.parse(dataStr);
              // Check if response contains an implementation plan list
              const planMatches = [
                ...doneData.totalContent.matchAll(/- \[[ xX]\]\s*([^\n]+)/g),
              ];
              if (planMatches.length > 0) {
                const newTasks: PlanTask[] = planMatches.map((m: any, idx: number) => ({
                  id: `task-${idx}-${Date.now()}`,
                  title: m[1],
                  completed: m[0].includes('[x]') || m[0].includes('[X]'),
                }));
                setPlanTasks(newTasks);
                setActiveDockTab('plan');
              }
            } catch (e) {}
          }
        }
      }
    } catch (err: any) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? { ...m, content: `Error: ${err.message}` }
            : m
        )
      );
    } finally {
      setIsStreaming(false);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId ? { ...m, isStreaming: false } : m
        )
      );
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

          {/* Bottom Dock (Terminal / Implementation Plan) */}
          <div className="bottom-dock">
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
          onFileSavedOrCreated={() => loadWorkspace()}
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
    </div>
  );
}

export default App;
