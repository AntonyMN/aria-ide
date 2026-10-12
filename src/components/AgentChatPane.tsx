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
} from 'lucide-react';
import { runTerminalCommand, readFileContent } from '../services/api';

interface Props {
  messages: ChatMessage[];
  onSendMessage: (
    prompt: string,
    options: { thinkingEnabled: boolean; mode: 'chat' | 'plan' }
  ) => void;
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
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

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
        // Trigger self-correction flow!
        onSendMessage(
          `Command "${command}" failed with error:\n${res.stderr || res.stdout}\nPlease analyze the error and fix it.`,
          { thinkingEnabled: true, mode: 'chat' }
        );
      } else {
        onFileSavedOrCreated();
      }
    } catch (e) {}
  };

  // Clean raw message content by stripping unclosed or raw <think> tags for markdown display
  const sanitizeMarkdown = (content: string) => {
    return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  };

  return (
    <div className="ide-ai-panel">
      <div className="ai-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Sparkles size={16} color="var(--accent-cyan)" />
          <span style={{ fontSize: 13, fontWeight: 700 }}>AI Coding Partner</span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
          {selectedModel || 'No model chosen'}
        </div>
      </div>

      <div className="ai-chat-messages">
        {messages.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-dim)', fontSize: 13 }}>
            <p style={{ fontWeight: 600, color: 'var(--text-main)', marginBottom: 6 }}>
              Local AI Session Ready
            </p>
            <p style={{ fontSize: 12 }}>
              Ask to inspect code, create implementation plans, propose edits, or run terminal commands. Responses will be rendered in formatted Markdown.
            </p>
          </div>
        )}

        {messages.map((msg) => {
          const displayContent = sanitizeMarkdown(msg.content);

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
                    {displayContent || (msg.isStreaming ? 'Thinking...' : '')}
                  </ReactMarkdown>
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
            <span style={{ fontSize: 11, color: 'var(--accent-cyan)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <RotateCw size={11} className="spin" /> Generating...
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <textarea
            className="ai-textarea"
            placeholder={
              mode === 'plan'
                ? 'Describe the feature to create an implementation plan...'
                : 'Ask local LLM to write, edit code, or run terminal commands...'
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
          <button
            className="send-btn"
            style={{ height: 'auto', alignSelf: 'stretch' }}
            onClick={() => handleSubmit()}
            disabled={isStreaming || !inputPrompt.trim()}
          >
            <Send size={15} />
          </button>
        </div>
      </div>
    </div>
  );
};
