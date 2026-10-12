import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  ChatMessage,
  LocalModel,
  ToolExecution,
  DiffProposal,
  PlanTask,
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
} from 'lucide-react';
import { runTerminalCommand, readFileContent, saveFileContent } from '../services/api';

interface Props {
  messages: ChatMessage[];
  onSendMessage: (
    prompt: string,
    options: { thinkingEnabled: boolean; mode: 'chat' | 'plan' }
  ) => void;
  onStopGeneration: () => void;
  selectedModel: string;
  isStreaming: boolean;
  onOpenDiffReview: (diff: DiffProposal) => void;
  workspacePath: string;
  onApplyPlan: (plan: PlanTask[]) => void;
  onFileSavedOrCreated: () => void;
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

  // Check for custom action headers like language-file:path/to/file or language-bash:run
  const match = /language-(\S+)/.exec(className || '');
  const lang = match ? match[1] : '';

  if (lang.startsWith('file:')) {
    const filePath = lang.replace('file:', '').trim();
    return (
      <div className="tool-pill" style={{ flexDirection: 'column', alignItems: 'stretch', margin: '10px 0', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <FileEdit size={14} color="var(--accent-cyan)" />
            <span style={{ fontWeight: 600 }}>Proposed File: <code>{filePath}</code></span>
          </div>
          <button
            className="btn-accept"
            style={{ padding: '3px 10px', fontSize: 11 }}
            onClick={() => onReviewFile(filePath, rawCode)}
          >
            Review Diff & Apply
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

  if (lang === 'bash:run') {
    return (
      <div className="tool-pill" style={{ justifyContent: 'space-between', margin: '8px 0', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Terminal size={14} color="var(--accent-amber)" />
          <span>Execute: <code style={{ color: 'var(--accent-amber)' }}>{rawCode}</code></span>
        </div>
        <button
          className="send-btn"
          style={{ padding: '3px 10px', fontSize: 11 }}
          onClick={() => onExecuteCommand(rawCode)}
        >
          <Play size={11} /> Run Now
        </button>
      </div>
    );
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(rawCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span>{lang || 'code'}</span>
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
  selectedModel,
  isStreaming,
  onOpenDiffReview,
  workspacePath,
  onApplyPlan,
  onFileSavedOrCreated,
}) => {
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
    const fileMatches = [
      ...content.matchAll(/```(?:file:([^\n]+))\n([\s\S]*?)```/g),
    ];
    const bashMatches = [
      ...content.matchAll(/```(?:bash:run)\n([\s\S]*?)```/g),
    ];

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
      for (let i = 0; i < fileMatches.length; i++) {
        const filePath = fileMatches[i][1].trim();
        const fileContent = fileMatches[i][2];
        const fullPath = filePath.startsWith('/') ? filePath : `${workspacePath}/${filePath}`;
        setExecutionState((prev) => ({
          ...prev,
          [msgId]: { status: 'running', log: `Writing file [${i + 1}/${fileMatches.length}]: ${filePath}...` },
        }));
        await saveFileContent(fullPath, fileContent);
      }

      onFileSavedOrCreated();

      // 2. Execute bash commands sequentially
      for (let j = 0; j < bashMatches.length; j++) {
        const cmd = bashMatches[j][1].trim();
        setExecutionState((prev) => ({
          ...prev,
          [msgId]: { status: 'running', log: `Executing command [${j + 1}/${bashMatches.length}]: ${cmd}...` },
        }));

        const res = await runTerminalCommand(cmd, workspacePath);
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
    if (!inputPrompt.trim() || isStreaming) return;
    onSendMessage(inputPrompt, { thinkingEnabled, mode });
    setInputPrompt('');
  };

  const handleReviewFileChange = async (filePath: string, newContent: string) => {
    try {
      let originalContent = '';
      try {
        const full = filePath.startsWith('/') ? filePath : `${workspacePath}/${filePath}`;
        const fileData = await readFileContent(full);
        originalContent = fileData.content;
      } catch (e) {
        originalContent = '// New file (does not exist yet)';
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
    try {
      const res = await runTerminalCommand(command, workspacePath);
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
    <div className="ide-ai-panel">
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
                      {currentExec?.status === 'running' ? 'Executing...' : currentExec?.status === 'done' ? 'Re-Run Actions' : 'Run All Actions'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

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
            placeholder="Tell the AI what to build or modify... (it will plan, generate files, and run commands)"
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
            <button
              className="send-btn"
              style={{
                height: 'auto',
                alignSelf: 'stretch',
                background: 'rgba(239, 68, 68, 0.25)',
                border: '1px solid #ef4444',
                color: '#ef4444',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '0 14px',
              }}
              onClick={onStopGeneration}
              title="Stop generation immediately (Esc)"
            >
              <Square size={13} fill="currentColor" />
              <span>Stop</span>
            </button>
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
