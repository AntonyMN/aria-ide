import React, { useState, useRef, useEffect } from 'react';
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
  Wrench,
  Terminal,
  FileEdit,
  ChevronDown,
  ChevronRight,
  Sparkles,
  AlertCircle,
  CheckCircle,
  Play,
  RotateCw,
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
              Ask to inspect code, create implementation plans, propose edits, or run terminal commands.
            </p>
          </div>
        )}

        {messages.map((msg) => {
          const { fileMatches, bashMatches } = extractActions(msg.content);

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

              {/* Message text */}
              <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                {msg.content}
              </div>

              {/* Detected File Edit Actions */}
              {fileMatches.length > 0 && (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {fileMatches.map((m, idx) => {
                    const filePath = m[1].trim();
                    const newContent = m[2];
                    return (
                      <div key={idx} className="tool-pill" style={{ justifyContent: 'space-between' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <FileEdit size={14} color="var(--accent-cyan)" />
                          <span>Proposed Edit: <strong>{filePath}</strong></span>
                        </div>
                        <button
                          className="btn-accept"
                          style={{ padding: '3px 8px', fontSize: 11 }}
                          onClick={() => handleReviewFileChange(filePath, newContent)}
                        >
                          Review Diff
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Detected Terminal Command Actions */}
              {bashMatches.length > 0 && (
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {bashMatches.map((m, idx) => {
                    const cmd = m[1].trim();
                    return (
                      <div key={idx} className="tool-pill" style={{ justifyContent: 'space-between' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Terminal size={14} color="var(--accent-amber)" />
                          <span>Run: <code>{cmd}</code></span>
                        </div>
                        <button
                          className="send-btn"
                          style={{ padding: '3px 8px', fontSize: 11 }}
                          onClick={() => handleExecuteCommand(cmd)}
                        >
                          <Play size={11} /> Execute
                        </button>
                      </div>
                    );
                  })}
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
