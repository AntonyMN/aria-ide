import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  ChatMessage,
  DiffProposal,
  PlanTask,
  ActivePlanExecution,
} from '../types';
import {
  Send,
  Brain,
  ListTodo,
  Terminal,
  FileEdit,
  ChevronDown,
  ChevronRight,
  Sparkles,
  Play,
  RotateCw,
  Copy,
  Check,
  Zap,
  CheckCircle2,
  AlertTriangle,
  Square,
  FileCode,
  Pause,
  Folder,
} from 'lucide-react';
import { runTerminalCommand, readFileContent, saveFileContent } from '../services/api';
import { promptText } from '../services/alerts';

interface Props {
  messages: ChatMessage[];
  onSendMessage: (
    prompt: string,
    options: { thinkingEnabled: boolean; mode: 'chat' | 'plan' }
  ) => void;
  onStopGeneration: () => void;
  onInterrupt?: (updateMessage?: string) => void;
  selectedModel: string;
  isStreaming: boolean;
  onOpenDiffReview: (diff: DiffProposal) => void;
  workspacePath: string;
  currentCwd?: string;
  onApplyPlan?: (plan: PlanTask[]) => void;
  onFileSavedOrCreated: (createdFilePath?: string) => void;
  width?: number;
  getOriginalContent?: (filePath: string) => string | undefined;
  activePlan?: ActivePlanExecution | null;
  onProceedNextPhase?: () => void;
  onSkipPhase?: () => void;
  onRunCommands?: (commands: string[]) => Promise<void> | void;
  onOpenLiveRunner?: () => void;
}

// Subcomponent for fenced code blocks with Copy button and custom interactive actions
const CodeBlock: React.FC<{
  className?: string;
  children: React.ReactNode;
  onReviewFile: (filePath: string, content: string) => void;
  onExecuteCommand: (command: string) => void;
}> = ({ className, children, onReviewFile, onExecuteCommand }) => {
  const [copied, setCopied] = useState(false);
  const rawCode = String(children).replace(/\n$/, '');

  const match = /language-(\S+)/.exec(className || '');
  const lang = match ? match[1] : '';

  // 1. Explicit file:path
  if (lang.startsWith('file:') || lang.startsWith('write:')) {
    const filePath = lang.replace(/^(file|write):/, '').trim();
    return (
      <div className="tool-pill" style={{ flexDirection: 'column', alignItems: 'stretch', margin: '10px 0', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <FileEdit size={14} color="var(--accent-cyan)" />
            <span style={{ fontWeight: 600 }}>File: <code>{filePath}</code></span>
            <span className="badge badge-safe" style={{ fontSize: 9, padding: '2px 5px' }}>✓ Applied Directly</span>
          </div>
          <button
            className="btn-accept"
            style={{ padding: '3px 10px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}
            onClick={() => onReviewFile(filePath, rawCode)}
          >
            <span>🔍 Review Changes</span>
          </button>
        </div>
        <div style={{
          maxHeight: 160,
          overflowY: 'auto',
          background: 'rgba(0, 0, 0, 0.4)',
          padding: 8,
          borderRadius: 6,
          fontFamily: 'var(--font-mono)',
          fontSize: 11.5,
          color: '#cbd5e1'
        }}>
          <pre>{rawCode}</pre>
        </div>
      </div>
    );
  }

  // 2. Explicit bash:run
  if (lang === 'bash:run') {
    return (
      <div className="tool-pill" style={{ justifyContent: 'space-between', margin: '8px 0', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Terminal size={14} color="var(--accent-cyan)" />
          <span>Execute on screen: <code style={{ color: 'var(--accent-cyan)' }}>{rawCode}</code></span>
        </div>
        <button
          className="send-btn"
          style={{
            padding: '3px 10px',
            fontSize: 11,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            background: 'rgba(0, 240, 255, 0.15)',
            border: '1px solid rgba(0, 240, 255, 0.35)',
            color: 'var(--accent-cyan)',
          }}
          onClick={() => onExecuteCommand(rawCode)}
          title="Run this shell command live on screen"
        >
          <Play size={10} fill="currentColor" /> Run On Screen
        </button>
      </div>
    );
  }

  // 3. Fallback Heuristic: Candidate filename in comment or preceding text
  const firstLine = rawCode.split('\n')[0].trim();
  const commentMatch = /(?:\/\/|\/\*|<!--|#)\s*([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]{1,8})/i.exec(firstLine);
  let candidateFile = commentMatch ? commentMatch[1] : '';

  if (!candidateFile && lang.includes(':')) {
    candidateFile = lang.split(':')[1].trim();
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(rawCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isBash = ['bash', 'sh', 'shell', 'zsh', 'terminal'].includes(lang.toLowerCase());

  const handleManualSave = async () => {
    if (candidateFile) {
      onReviewFile(candidateFile, rawCode);
    } else {
      const fileName = await promptText({
        title: 'Save Code to File',
        placeholder: 'e.g. script.js, index.html',
        confirmButtonText: 'Save File',
      });
      if (fileName) {
        onReviewFile(fileName, rawCode);
      }
    }
  };

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {candidateFile ? <FileCode size={13} color="var(--accent-cyan)" /> : null}
          <span style={{ fontWeight: 600 }}>{candidateFile ? candidateFile : (lang || 'code')}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {isBash && (
            <button
              className="send-btn"
              style={{
                padding: '2px 8px',
                fontSize: 11,
                height: 'auto',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                background: 'rgba(0, 240, 255, 0.15)',
                border: '1px solid rgba(0, 240, 255, 0.35)',
                color: 'var(--accent-cyan)',
              }}
              onClick={() => onExecuteCommand(rawCode)}
              title="Run this shell command live on screen"
            >
              <Play size={10} fill="currentColor" />
              <span>Run On Screen</span>
            </button>
          )}

          {!isBash && (
            <button
              className="btn-accept"
              style={{ padding: '2px 8px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}
              onClick={handleManualSave}
              title={candidateFile ? `Save directly to ${candidateFile}` : 'Save code to a file in workspace'}
            >
              <Zap size={10} />
              <span>{candidateFile ? `Review Changes (${candidateFile})` : 'Review Changes...'}</span>
            </button>
          )}

          <button
            className="icon-btn"
            style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, padding: '2px 6px' }}
            onClick={handleCopy}
            title="Copy code"
          >
            {copied ? <Check size={12} color="var(--accent-emerald)" /> : <Copy size={12} />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
      </div>
      <div className="markdown-code-content">
        <pre>{rawCode}</pre>
      </div>
    </div>
  );
};

export const AgentChatPane: React.FC<Props> = ({
  messages,
  onSendMessage,
  onStopGeneration,
  onInterrupt,
  selectedModel,
  isStreaming,
  onOpenDiffReview,
  workspacePath,
  currentCwd,
  onApplyPlan,
  onFileSavedOrCreated,
  width,
  getOriginalContent,
  activePlan,
  onProceedNextPhase,
  onSkipPhase,
  onRunCommands,
  onOpenLiveRunner,
}) => {
  // Mark onApplyPlan as referenced to avoid lint warnings
  void onApplyPlan;

  const [inputPrompt, setInputPrompt] = useState('');
  const [thinkingEnabled, setThinkingEnabled] = useState(true);
  const [mode, setMode] = useState<'chat' | 'plan'>('chat');
  const [autoExecute, setAutoExecute] = useState(true);
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});
  const [executedMessageIds, setExecutedMessageIds] = useState<Set<string>>(new Set());
  const [executionState, setExecutionState] = useState<{
    [msgId: string]: { status: 'idle' | 'running' | 'done' | 'error'; log?: string };
  }>({});

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isExecutingRef = useRef(false);
  const autoRetryCountRef = useRef(0);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

  // Helper to extract file modifications and bash commands from raw markdown text
  const extractActions = (content: string) => {
    const fileMatches: Array<{ path: string; content: string }> = [];
    const bashMatches: Array<{ command: string }> = [];

    // 1. Explicit ```file:filename
    for (const m of content.matchAll(/```(?:file:([^\n]+))\n([\s\S]*?)```/g)) {
      const p = m[1].trim().replace(/^['"`]+|['"`]+$/g, '').replace(/^(\.\/|\/)/, '');
      if (p) fileMatches.push({ path: p, content: m[2] });
    }

    // 2. Standard or explicit bash/sh/shell blocks: ```bash or ```sh or ```bash:run
    for (const m of content.matchAll(/```(?:bash|sh|cmd|shell|zsh)(?::run)?[\r\n]([\s\S]*?)```/gi)) {
      const rawBlock = m[1].trim();
      const lines = rawBlock.split(/[\r\n]+/);
      for (let line of lines) {
        line = line.trim().replace(/^[$#]\s*/, '').trim();
        if (!line || line.startsWith('#') || line.startsWith('//')) continue;
        if (line.startsWith('cd ') && !line.includes('&&') && !line.includes(';')) continue;
        if (!bashMatches.some((b) => b.command === line)) {
          bashMatches.push({ command: line });
        }
      }
    }

    // 3. Fallback Heuristic: Filename in parentheses or text preceding a code block
    // e.g. "create a new JavaScript file ( script.js ) to handle the calculations: ```javascript"
    const heuristicRegex = /(?:create|file|in|named|modify)?\s*\(?\s*([a-zA-Z0-9_\-./]+\.(?:js|ts|jsx|tsx|html|css|json|py|php|rs|vue|sh|md|sql))\s*\)?[\s\S]{0,90}```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/gi;
    for (const m of content.matchAll(heuristicRegex)) {
      const fileName = m[1].trim().replace(/^['"`]+|['"`]+$/g, '').replace(/^(\.\/|\/)/, '');
      const code = m[2];
      if (!fileName.includes(' ') && !fileMatches.some((f) => f.path === fileName) && code.trim().length > 0) {
        fileMatches.push({ path: fileName, content: code });
      }
    }

    // 4. Fallback: Code block where first line is a filename comment: // script.js
    const commentRegex = /```(?:[a-zA-Z0-9_-]+)?\n(?:\/\/|\/\*|<!--|#)\s*([a-zA-Z0-9_\-./]+\.(?:js|ts|jsx|tsx|html|css|json|py|php|rs|vue|sh|md|sql))[\s\S]*?\n([\s\S]*?)```/gi;
    for (const m of content.matchAll(commentRegex)) {
      const fileName = m[1].trim().replace(/^['"`]+|['"`]+$/g, '').replace(/^(\.\/|\/)/, '');
      const code = m[0].replace(/```[^\n]*\n/, '').replace(/\n```$/, '');
      if (!fileName.includes(' ') && !fileMatches.some((f) => f.path === fileName)) {
        fileMatches.push({ path: fileName, content: code });
      }
    }

    return { fileMatches, bashMatches };
  };

  // Autonomous batch execution of all commands & file modifications
  const handleExecuteAllActions = async (msgId: string, content: string) => {
    if (isExecutingRef.current) return;
    const { fileMatches, bashMatches } = extractActions(content);
    if (fileMatches.length === 0 && bashMatches.length === 0) return;

    // Mark as executed immediately to prevent duplicate execution loops!
    setExecutedMessageIds((prev) => new Set(prev).add(msgId));
    isExecutingRef.current = true;

    setExecutionState((prev) => ({
      ...prev,
      [msgId]: { status: 'running', log: 'Starting execution...' },
    }));

    try {
      // 1. Write / update files
      let lastCreatedPath = '';
      for (let i = 0; i < fileMatches.length; i++) {
        const filePath = fileMatches[i].path.trim();
        const fileContent = fileMatches[i].content;
        const fullPath = filePath.startsWith('/') ? filePath : `${workspacePath}/${filePath}`;
        setExecutionState((prev) => ({
          ...prev,
          [msgId]: { status: 'running', log: `Writing file [${i + 1}/${fileMatches.length}]: ${filePath}...` },
        }));
        await saveFileContent(fullPath, fileContent);
        lastCreatedPath = fullPath;
      }

      onFileSavedOrCreated(lastCreatedPath);

      // 2. Execute bash commands sequentially on screen
      if (bashMatches.length > 0) {
        if (onRunCommands) {
          setExecutionState((prev) => ({
            ...prev,
            [msgId]: {
              status: 'running',
              log: `Streaming ${bashMatches.length} command(s) live on screen in Command Runner...`,
            },
          }));
          const commands = bashMatches.map((b) => b.command);
          await onRunCommands(commands);
          setExecutionState((prev) => ({
            ...prev,
            [msgId]: {
              status: 'done',
              log: `Executed ${fileMatches.length > 0 ? `${fileMatches.length} files and ` : ''}${bashMatches.length} command(s) live on screen!`,
            },
          }));
        } else {
          for (let j = 0; j < bashMatches.length; j++) {
            const cmd = bashMatches[j].command.trim();
            setExecutionState((prev) => ({
              ...prev,
              [msgId]: { status: 'running', log: `Executing command [${j + 1}/${bashMatches.length}]: ${cmd}...` },
            }));

            const res = await runTerminalCommand(cmd, currentCwd || workspacePath);
            if (res.hasError) {
              setExecutionState((prev) => ({
                ...prev,
                [msgId]: { status: 'error', log: `Command failed: ${cmd}\n${res.stderr || res.stdout}` },
              }));

              // Strict limit: only allow 1 automatic self-correction attempt to prevent infinite loops!
              if (autoRetryCountRef.current < 1) {
                autoRetryCountRef.current++;
                onSendMessage(
                  `Command failed:\n\`\`\`bash\n${cmd}\n\`\`\`\nError output:\n\`\`\`\n${res.stderr || res.stdout}\n\`\`\`\nPlease analyze this error, adjust the plan, and provide the fix.`,
                  { thinkingEnabled: true, mode: 'chat' }
                );
              }
              isExecutingRef.current = false;
              return;
            }
          }
          setExecutionState((prev) => ({
            ...prev,
            [msgId]: { status: 'done', log: 'All actions executed successfully!' },
          }));
        }
      } else {
        setExecutionState((prev) => ({
          ...prev,
          [msgId]: { status: 'done', log: 'All files written successfully!' },
        }));
      }

      setExecutionState((prev) => ({
        ...prev,
        [msgId]: { status: 'done', log: 'All actions executed successfully!' },
      }));
    } catch (err: any) {
      setExecutionState((prev) => ({
        ...prev,
        [msgId]: { status: 'error', log: `Execution error: ${err.message}` },
      }));
    } finally {
      isExecutingRef.current = false;
    }
  };

  // Watch for completed streaming responses and auto-execute if enabled
  useEffect(() => {
    if (isStreaming || !autoExecute || isExecutingRef.current) return;

    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'assistant' && !executedMessageIds.has(lastMsg.id)) {
      const { fileMatches, bashMatches } = extractActions(lastMsg.content);
      if (fileMatches.length > 0 || bashMatches.length > 0) {
        handleExecuteAllActions(lastMsg.id, lastMsg.content);
      }
    }
  }, [isStreaming, messages, autoExecute]);

  const toggleThinking = (id: string) => {
    setExpandedThinking((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputPrompt.trim()) return;

    // If currently streaming / executing, this prompt acts as an interruption & guidance command!
    if (isStreaming) {
      if (onInterrupt) {
        onInterrupt(inputPrompt);
        setInputPrompt('');
      }
      return;
    }

    onSendMessage(inputPrompt, { thinkingEnabled, mode });
    setInputPrompt('');
  };

  const handleReviewFileChange = async (filePath: string, newContent: string) => {
    try {
      let originalContent = '';
      const cached = getOriginalContent ? getOriginalContent(filePath) : undefined;
      if (cached !== undefined) {
        originalContent = cached;
      } else {
        try {
          const full = filePath.startsWith('/') ? filePath : `${workspacePath}/${filePath}`;
          const fileData = await readFileContent(full);
          originalContent = fileData.content;
        } catch (e) {
          originalContent = '// New file (created directly by AI)';
        }
      }

      onOpenDiffReview({
        filePath,
        originalContent,
        modifiedContent: newContent,
        status: 'pending',
      });
    } catch (err) {
      console.error('Error preparing diff:', err);
    }
  };

  const handleExecuteCommand = async (command: string) => {
    if (onRunCommands) {
      onRunCommands([command]);
      return;
    }
    try {
      const res = await runTerminalCommand(command, currentCwd || workspacePath);
      if (res.hasError) {
        onSendMessage(
          `Command "${command}" failed with error:\n${res.stderr || res.stdout}\nPlease analyze the error and fix it.`,
          { thinkingEnabled: true, mode: 'chat' }
        );
      } else {
        onFileSavedOrCreated();
      }
    } catch (e) {}
  };

  const sanitizeMarkdown = (content: string) => {
    return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  };

  return (
    <div
      className="ide-ai-panel"
      style={width !== undefined ? { width: `${width}px` } : undefined}
    >
      <div className="ai-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Sparkles size={16} color="var(--accent-cyan)" />
          <span style={{ fontSize: 13, fontWeight: 700 }}>Autonomous AI Agent</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {isStreaming && (
            <button
              className="icon-btn"
              style={{
                color: '#ef4444',
                fontSize: 11,
                fontWeight: 600,
                padding: '2px 8px',
                background: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: 4,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
              onClick={onStopGeneration}
              title="Stop generation immediately (Esc)"
            >
              <Square size={11} fill="currentColor" /> Stop
            </button>
          )}
          <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
            {selectedModel || 'No model chosen'}
          </span>
        </div>
      </div>

      <div className="ai-chat-messages">
        {messages.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-dim)', fontSize: 13 }}>
            <p style={{ fontWeight: 600, color: 'var(--text-main)', marginBottom: 6 }}>
              Autonomous Developer Ready
            </p>
            <p style={{ fontSize: 12 }}>
              Give a prompt (e.g. <em>"Scaffold a Laravel Breeze Inertia Vue shop"</em>). The model will design a plan, generate files, and automatically run commands in your workspace.
            </p>
          </div>
        )}

        {messages.map((msg) => {
          const displayContent = sanitizeMarkdown(msg.content);
          const { fileMatches, bashMatches } = extractActions(msg.content);
          const hasActions = fileMatches.length > 0 || bashMatches.length > 0;
          const currentExec = executionState[msg.id];

          return (
            <div
              key={msg.id}
              className={`message-card ${
                msg.role === 'user' ? 'message-user' : 'message-assistant'
              }`}
            >
              {/* Thinking trace accordion */}
              {msg.thinking && (
                <div className="thinking-accordion">
                  <div
                    className="thinking-header"
                    onClick={() => toggleThinking(msg.id)}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Brain size={14} />
                      <span>Reasoning Trace ({msg.thinking.length} chars)</span>
                    </div>
                    {expandedThinking[msg.id] ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronRight size={14} />
                    )}
                  </div>
                  {(expandedThinking[msg.id] ?? true) && (
                    <div className="thinking-body">{msg.thinking}</div>
                  )}
                </div>
              )}

              {/* Formatted Markdown Content */}
              {msg.role === 'user' ? (
                <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{msg.content}</div>
              ) : (
                <div className="markdown-body">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      code({ node, className, children, ...props }: any) {
                        const isInline = !className && typeof children === 'string' && !children.includes('\n');
                        if (isInline) {
                          return <code className="markdown-inline-code" {...props}>{children}</code>;
                        }
                        return (
                          <CodeBlock
                            className={className}
                            onReviewFile={handleReviewFileChange}
                            onExecuteCommand={handleExecuteCommand}
                          >
                            {children}
                          </CodeBlock>
                        );
                      },
                    }}
                  >
                    {displayContent || (msg.isStreaming ? 'Analyzing task and generating plan...' : '')}
                  </ReactMarkdown>
                </div>
              )}

              {/* Autonomous Command & Structure Audit Card */}
              {msg.commandAudit && (
                <div style={{
                  marginTop: 10,
                  padding: '10px 12px',
                  borderRadius: 8,
                  background: 'rgba(0, 240, 255, 0.05)',
                  border: '1px solid rgba(0, 240, 255, 0.25)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Sparkles size={14} color="var(--accent-cyan)" />
                      <span style={{ fontWeight: 700, fontSize: 12, color: 'var(--accent-cyan)' }}>
                        Command & Structure Audit
                      </span>
                    </div>
                    <span className={`badge badge-${msg.commandAudit.status === 'success' ? 'safe' : 'warning'}`} style={{ fontSize: 9 }}>
                      {msg.commandAudit.status.toUpperCase()}
                    </span>
                  </div>

                  <div style={{ fontSize: 12, color: 'var(--text-main)', lineHeight: 1.4 }}>
                    {msg.commandAudit.summary}
                  </div>

                  {msg.commandAudit.relativeCwd && msg.commandAudit.relativeCwd !== '.' && (
                    <div style={{
                      fontSize: 11,
                      color: 'var(--accent-cyan)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      background: 'rgba(0,0,0,0.3)',
                      padding: '2px 6px',
                      borderRadius: 4,
                      alignSelf: 'flex-start',
                    }}>
                      <Folder size={11} />
                      <span>CWD moved into: <code>./{msg.commandAudit.relativeCwd}</code></span>
                    </div>
                  )}

                  {msg.commandAudit.whatHasBeenDone && (
                    <div style={{
                      fontSize: 11.5,
                      color: '#93c5fd',
                      background: 'rgba(59, 130, 246, 0.08)',
                      padding: '5px 8px',
                      borderRadius: 4,
                      borderLeft: '2px solid #3b82f6',
                    }}>
                      <strong style={{ color: '#60a5fa' }}>Already Done in Folder: </strong>
                      {msg.commandAudit.whatHasBeenDone}
                    </div>
                  )}

                  {msg.commandAudit.existingItems && msg.commandAudit.existingItems.length > 0 && (
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      flexWrap: 'wrap',
                      fontSize: 10.5,
                      color: 'var(--text-dim)',
                    }}>
                      <span>In folder:</span>
                      {msg.commandAudit.existingItems.slice(0, 8).map((it) => (
                        <span key={it} style={{ background: 'rgba(255,255,255,0.05)', padding: '1px 5px', borderRadius: 3, fontFamily: 'var(--font-mono)' }}>
                          {it}
                        </span>
                      ))}
                      {msg.commandAudit.existingItems.length > 8 && (
                        <span>+{msg.commandAudit.existingItems.length - 8} more</span>
                      )}
                    </div>
                  )}

                  {msg.commandAudit.wayForward && (
                    <div style={{
                      fontSize: 11.5,
                      color: 'var(--text-muted)',
                      background: 'rgba(0,0,0,0.3)',
                      padding: '5px 8px',
                      borderRadius: 4,
                      borderLeft: '2px solid var(--accent-cyan)',
                    }}>
                      <strong style={{ color: 'var(--accent-cyan)' }}>Way Forward from AI: </strong>
                      {msg.commandAudit.wayForward}
                    </div>
                  )}

                  {msg.commandAudit.suggestedNextCommands && msg.commandAudit.suggestedNextCommands.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 }}>
                      <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Next Step:</span>
                      {msg.commandAudit.suggestedNextCommands.map((cmd, cIdx) => (
                        <button
                          key={cIdx}
                          className="send-btn"
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            padding: '2px 8px',
                            background: 'rgba(0, 240, 255, 0.12)',
                            border: '1px solid rgba(0, 240, 255, 0.35)',
                            borderRadius: 4,
                            color: 'var(--accent-cyan)',
                            fontSize: 11,
                            fontFamily: 'var(--font-mono)',
                            cursor: 'pointer',
                          }}
                          onClick={() => {
                            if (onRunCommands) onRunCommands([cmd]);
                            else handleExecuteCommand(cmd);
                          }}
                          title={`Run suggested command live on screen: ${cmd}`}
                        >
                          <Play size={10} fill="currentColor" />
                          <span>{cmd}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Autonomous Action Execution Status Bar */}
              {hasActions && msg.role === 'assistant' && !msg.isStreaming && (
                <div style={{
                  marginTop: 12,
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: 'rgba(0, 0, 0, 0.35)',
                  border: '1px solid var(--border-color)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                    {currentExec?.status === 'running' ? (
                      <RotateCw size={14} className="spin" color="var(--accent-cyan)" />
                    ) : currentExec?.status === 'done' ? (
                      <CheckCircle2 size={14} color="var(--accent-emerald)" />
                    ) : currentExec?.status === 'error' ? (
                      <AlertTriangle size={14} color="var(--accent-rose)" />
                    ) : (
                      <Zap size={14} color="var(--accent-amber)" />
                    )}
                    <span style={{ color: currentExec?.status === 'error' ? 'var(--accent-rose)' : undefined }}>
                      {currentExec?.log || `${fileMatches.length} files, ${bashMatches.length} commands`}
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: 6 }}>
                    {bashMatches.length > 0 && onOpenLiveRunner && (
                      <button
                        className="send-btn"
                        style={{
                          padding: '4px 8px',
                          fontSize: 11,
                          background: 'rgba(0, 240, 255, 0.1)',
                          color: 'var(--accent-cyan)',
                          border: '1px solid rgba(0, 240, 255, 0.25)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                        onClick={onOpenLiveRunner}
                        title="Switch to Live On-Screen Command Runner"
                      >
                        <Terminal size={11} /> Screen Runner
                      </button>
                    )}
                    {currentExec?.status === 'error' && (
                      <button
                        className="send-btn"
                        style={{ padding: '4px 8px', fontSize: 11, background: 'rgba(239, 68, 68, 0.25)', color: '#ef4444' }}
                        onClick={() => {
                          onSendMessage(
                            `Fix error for command failure:\n${currentExec.log}`,
                            { thinkingEnabled: true, mode: 'chat' }
                          );
                        }}
                      >
                        Fix Error with AI
                      </button>
                    )}
                    <button
                      className="send-btn"
                      style={{
                        padding: '4px 10px',
                        fontSize: 11,
                        background: currentExec?.status === 'done' ? 'rgba(16, 185, 129, 0.2)' : undefined,
                        color: currentExec?.status === 'done' ? 'var(--accent-emerald)' : undefined,
                      }}
                      onClick={() => handleExecuteAllActions(msg.id, msg.content)}
                      disabled={currentExec?.status === 'running'}
                    >
                      {currentExec?.status === 'running'
                        ? 'Running On Screen...'
                        : currentExec?.status === 'done'
                        ? 'Re-Run On Screen'
                        : 'Run On Screen'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Phase Breather / Interrupted Banner */}
      {activePlan && (activePlan.status === 'paused' || activePlan.status === 'interrupted') && (
        <div className="phase-breather-banner">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span
                className={`badge badge-${activePlan.status === 'interrupted' ? 'warning' : 'safe'}`}
                style={{ fontSize: 10, padding: '2px 6px', display: 'flex', alignItems: 'center', gap: 4 }}
              >
                <Pause size={10} /> {activePlan.status === 'interrupted' ? 'Paused (Interrupted by User)' : 'Paused for Review'}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                {activePlan.lastInterruption
                  ? `Update: "${activePlan.lastInterruption.message.slice(0, 40)}..."`
                  : `Phase ${activePlan.currentPhaseIndex} of ${activePlan.phases.length} complete`}
              </span>
            </div>
            <div style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: 'var(--text-main)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}>
              {activePlan.phases[activePlan.currentPhaseIndex]
                ? `Ready for Phase ${activePlan.currentPhaseIndex + 1}: ${activePlan.phases[activePlan.currentPhaseIndex].title}`
                : 'All phases ready'}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {onSkipPhase && (
              <button
                className="btn-skip-phase"
                onClick={onSkipPhase}
                title="Skip this phase and proceed to next"
              >
                Skip
              </button>
            )}
            {onProceedNextPhase && (
              <button
                className="btn-proceed-phase"
                onClick={onProceedNextPhase}
                title={`Run Phase ${activePlan.currentPhaseIndex + 1}`}
              >
                <Play size={12} fill="currentColor" /> Proceed to Phase {activePlan.currentPhaseIndex + 1}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Input bar */}
      <div className="ai-input-bar">
        <div className="ai-controls">
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className={`toggle-chip ${autoExecute ? 'active' : ''}`}
              onClick={() => setAutoExecute(!autoExecute)}
              title="Automatically run emitted commands and create files"
            >
              <Zap size={13} /> Auto-Execute
            </button>
            <button
              className={`toggle-chip ${thinkingEnabled ? 'active' : ''}`}
              onClick={() => setThinkingEnabled(!thinkingEnabled)}
              title="Enable deep thinking traces"
            >
              <Brain size={13} /> Thinking
            </button>
            <button
              className={`toggle-chip ${mode === 'plan' ? 'active' : ''}`}
              onClick={() => setMode(mode === 'plan' ? 'chat' : 'plan')}
              title="Instruct model to create a structured implementation plan first"
            >
              <ListTodo size={13} /> Plan Mode
            </button>
          </div>
          {isStreaming && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--accent-cyan)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <RotateCw size={11} className="spin" /> Generating...
              </span>
              <button
                className="btn-interrupt"
                style={{ padding: '2px 8px', fontSize: 11, height: 'auto' }}
                onClick={() => {
                  if (onInterrupt) onInterrupt(inputPrompt);
                }}
                title="Pause execution to guide or update the AI"
              >
                <Pause size={10} /> Interrupt
              </button>
              <button
                className="icon-btn"
                style={{
                  color: '#ef4444',
                  fontSize: 10,
                  fontWeight: 600,
                  padding: '2px 6px',
                  background: 'rgba(239, 68, 68, 0.15)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  borderRadius: 4,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 3,
                }}
                onClick={onStopGeneration}
                title="Stop generation (Esc)"
              >
                <Square size={9} fill="currentColor" /> Stop
              </button>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <textarea
            className="ai-textarea"
            placeholder={
              isStreaming
                ? "Type a command or update to interrupt the AI with new guidance..."
                : activePlan && (activePlan.status === 'paused' || activePlan.status === 'interrupted')
                ? "Type 'proceed' to resume, or provide updated guidance/instructions to revise..."
                : "Tell the AI what to build or modify... (it will plan, generate files, and run commands on screen)"
            }
            value={inputPrompt}
            onChange={(e) => setInputPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
          {isStreaming ? (
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="btn-interrupt"
                style={{
                  height: 'auto',
                  alignSelf: 'stretch',
                  padding: '0 12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
                onClick={() => handleSubmit()}
                title="Interrupt and update AI with typed instructions"
              >
                <Pause size={13} />
                <span>{inputPrompt.trim() ? 'Interrupt & Update' : 'Pause'}</span>
              </button>
              <button
                className="send-btn"
                style={{
                  height: 'auto',
                  alignSelf: 'stretch',
                  background: 'rgba(239, 68, 68, 0.25)',
                  border: '1px solid #ef4444',
                  color: '#ef4444',
                  padding: '0 10px',
                }}
                onClick={onStopGeneration}
                title="Stop generation immediately (Esc)"
              >
                <Square size={13} fill="currentColor" />
              </button>
            </div>
          ) : (
            <button
              className="send-btn"
              style={{ height: 'auto', alignSelf: 'stretch' }}
              onClick={() => handleSubmit()}
              disabled={!inputPrompt.trim()}
              title="Send prompt"
            >
              <Send size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
