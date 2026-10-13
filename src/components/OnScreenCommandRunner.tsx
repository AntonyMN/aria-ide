import React, { useState, useRef, useEffect } from 'react';
import {
  Terminal,
  Play,
  Pause,
  RotateCw,
  CheckCircle2,
  AlertTriangle,
  Folder,
  ArrowRight,
  CornerDownRight,
  Sparkles,
  Copy,
  Check,
} from 'lucide-react';
import type { LiveCommandQueueItem } from '../types';

interface Props {
  queue: LiveCommandQueueItem[];
  currentIndex: number;
  isRunning: boolean;
  isPaused: boolean;
  currentCwd: string;
  workspacePath: string;
  onInterrupt: (updateMessage?: string) => void;
  onResume: () => void;
  onSkip?: () => void;
  onRunCustomCommand?: (command: string) => void;
}

export const OnScreenCommandRunner: React.FC<Props> = ({
  queue,
  currentIndex,
  isRunning,
  isPaused,
  currentCwd,
  workspacePath,
  onInterrupt,
  onResume,
  onSkip,
  onRunCustomCommand,
}) => {
  const [copied, setCopied] = useState(false);
  const [isInterruptModalOpen, setIsInterruptModalOpen] = useState(false);
  const [interruptNote, setInterruptNote] = useState('');
  const [selectedQueueIndex, setSelectedQueueIndex] = useState<number | null>(null);
  const outputEndRef = useRef<HTMLDivElement>(null);

  const activeIndex = selectedQueueIndex !== null && queue[selectedQueueIndex] ? selectedQueueIndex : currentIndex;
  const activeItem = queue[activeIndex] || queue[queue.length - 1] || null;
  const isTerminalStreaming = isRunning && activeItem && activeItem.status === 'running';

  // Auto-scroll output terminal window to bottom as new chunks stream in
  useEffect(() => {
    if (outputEndRef.current) {
      outputEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [activeItem?.stdout, activeItem?.stderr]);

  const handleCopyOutput = () => {
    if (!activeItem) return;
    const text = `${activeItem.stdout}\n${activeItem.stderr}`.trim();
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleTriggerInterrupt = () => {
    setIsInterruptModalOpen(true);
    onInterrupt(); // Pause current execution
  };

  const handleSendInterruptFeedback = () => {
    if (!interruptNote.trim()) return;
    onInterrupt(interruptNote);
    setIsInterruptModalOpen(false);
    setInterruptNote('');
  };

  const relCwd = currentCwd.startsWith(workspacePath)
    ? currentCwd.slice(workspacePath.length).replace(/^(\/|\\)/, '') || '.'
    : currentCwd;

  return (
    <div className="on-screen-runner">
      {/* Top Runner Header */}
      <div className="runner-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Terminal size={15} color="var(--accent-cyan)" />
            <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: '0.3px' }}>
              On-Screen Live Command Runner
            </span>
          </div>

          {/* Running Status Badge */}
          {isRunning ? (
            <span className="badge badge-running" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span className="pulse-dot" />
              <span>Running {currentIndex + 1} of {queue.length}</span>
            </span>
          ) : isPaused ? (
            <span className="badge badge-warning" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <Pause size={10} />
              <span>Paused / Interrupted</span>
            </span>
          ) : (
            <span className="badge badge-safe" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <CheckCircle2 size={10} />
              <span>Idle / Ready</span>
            </span>
          )}

          {/* Active CWD Pill */}
          <div
            className="runner-cwd-pill"
            title={`Full Path: ${currentCwd}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 11,
              background: 'rgba(0, 240, 255, 0.08)',
              border: '1px solid rgba(0, 240, 255, 0.25)',
              padding: '2px 8px',
              borderRadius: 4,
              color: 'var(--accent-cyan)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            <Folder size={12} />
            <span>cwd: ./{relCwd}</span>
          </div>
        </div>

        {/* Action Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {isRunning && (
            <button
              className="btn-interrupt"
              onClick={handleTriggerInterrupt}
              title="Interrupt execution and update the AI with new information"
            >
              <Pause size={12} />
              <span>Interrupt & Update</span>
            </button>
          )}

          {isPaused && (
            <button
              className="btn-resume"
              onClick={onResume}
              title="Resume running subsequent commands"
            >
              <Play size={12} fill="currentColor" />
              <span>Resume Execution</span>
            </button>
          )}

          {isRunning && onSkip && (
            <button
              className="btn-skip-cmd"
              onClick={onSkip}
              title="Skip this command and move to next"
            >
              <span>Skip</span>
            </button>
          )}

          <button
            className="icon-btn"
            style={{ padding: '4px 8px', fontSize: 11 }}
            onClick={handleCopyOutput}
            title="Copy command output"
          >
            {copied ? <Check size={12} color="var(--accent-emerald)" /> : <Copy size={12} />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
      </div>

      {/* Main Runner Content: Live Terminal View & Sequential Progress */}
      <div className="runner-body">
        {/* Left: Synchronous Command Sequence Queue List */}
        <div className="runner-queue-list">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Command Pipeline ({queue.length})
            </span>
            {selectedQueueIndex !== null && selectedQueueIndex !== currentIndex && (
              <button
                className="icon-btn"
                style={{ fontSize: 10, padding: '1px 6px', color: 'var(--accent-cyan)' }}
                onClick={() => setSelectedQueueIndex(null)}
                title="Follow active command output"
              >
                Follow Live ↪
              </button>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', flex: 1 }}>
            {queue.map((item, idx) => {
              const isSelected = idx === activeIndex;
              return (
                <div
                  key={item.id || idx}
                  className={`queue-item-card ${isSelected ? 'active' : ''} ${item.status}`}
                  onClick={() => setSelectedQueueIndex(idx)}
                  style={{ cursor: 'pointer' }}
                  title="Click to view output & audit"
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                      {item.status === 'running' ? (
                        <RotateCw size={12} className="spin" color="var(--accent-cyan)" />
                      ) : item.status === 'completed' ? (
                        <CheckCircle2 size={12} color="var(--accent-emerald)" />
                      ) : item.status === 'error' ? (
                        <AlertTriangle size={12} color="var(--accent-rose)" />
                      ) : item.status === 'interrupted' ? (
                        <Pause size={12} color="var(--accent-amber)" />
                      ) : (
                        <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>#{idx + 1}</span>
                      )}
                      <code style={{ fontSize: 11.5, fontWeight: 600, color: isSelected ? 'var(--accent-cyan)' : undefined }}>
                        {item.command}
                      </code>
                    </div>
                    {item.audit?.relativeCwd && item.audit.relativeCwd !== '.' && (
                      <span className="badge badge-safe" style={{ fontSize: 9, padding: '1px 5px' }}>
                        ↪ ./{item.audit.relativeCwd}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
            {queue.length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--text-dim)', fontStyle: 'italic', padding: 8 }}>
                No commands in queue. When commands appear, they will run here sequentially on screen.
              </div>
            )}
          </div>
        </div>

        {/* Center: Live Terminal Output Screen */}
        <div className="runner-terminal-viewport">
          <div className="runner-terminal-bar">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444' }} />
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#f59e0b' }} />
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981' }} />
              <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                {activeItem ? `$ ${activeItem.command}` : 'Live Output'}
              </span>
            </div>
            {isTerminalStreaming && (
              <span style={{ fontSize: 11, color: 'var(--accent-cyan)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <RotateCw size={11} className="spin" /> Streaming live output...
              </span>
            )}
          </div>

          <div className="runner-console-box">
            {activeItem ? (
              <>
                <div style={{ color: '#00f0ff', marginBottom: 4 }}>
                  [aria] {activeItem.cwd}$ {activeItem.command}
                </div>
                {activeItem.stdout && (
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#e2e8f0' }}>
                    {activeItem.stdout}
                  </pre>
                )}
                {activeItem.stderr && (
                  <pre style={{ margin: '4px 0 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#f87171' }}>
                    {activeItem.stderr}
                  </pre>
                )}
                {!activeItem.stdout && !activeItem.stderr && activeItem.status === 'running' && (
                  <div style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>
                    Starting process in {activeItem.cwd}...
                  </div>
                )}
                <div ref={outputEndRef} />
              </>
            ) : (
              <div style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>
                Waiting for command execution...
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom: Structure Audit & LLM Way Forward Banner */}
      {activeItem?.audit && (
        <div className="runner-audit-banner">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flex: 1 }}>
            <div style={{ marginTop: 2 }}>
              {activeItem.audit.status === 'success' ? (
                <CheckCircle2 size={16} color="var(--accent-emerald)" />
              ) : activeItem.audit.status === 'warning' ? (
                <AlertTriangle size={16} color="var(--accent-amber)" />
              ) : (
                <AlertTriangle size={16} color="var(--accent-rose)" />
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, fontSize: 12, color: 'var(--text-main)' }}>
                  File Structure & LLM Audit:
                </span>
                <span style={{ fontSize: 11.5, color: '#e2e8f0' }}>
                  {activeItem.audit.summary}
                </span>
                {activeItem.audit.relativeCwd && activeItem.audit.relativeCwd !== '.' && (
                  <span className="badge badge-safe" style={{ fontSize: 10, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <ArrowRight size={10} /> Switched CWD to ./{activeItem.audit.relativeCwd}
                  </span>
                )}
              </div>

              {/* Created Folders / Files Diff */}
              {(activeItem.audit.createdDirs.length > 0 || activeItem.audit.createdFiles.length > 0) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-dim)' }}>
                  <span>Created:</span>
                  {activeItem.audit.createdDirs.map((d) => (
                    <span key={d} style={{ color: 'var(--accent-cyan)', fontWeight: 600 }}>
                      📁 {d}/
                    </span>
                  ))}
                  {activeItem.audit.createdFiles.map((f) => (
                    <span key={f} style={{ color: 'var(--accent-emerald)' }}>
                      📄 {f}
                    </span>
                  ))}
                </div>
              )}

              {/* What Has Been Done in Folder */}
              {activeItem.audit.whatHasBeenDone && (
                <div style={{
                  fontSize: 11.5,
                  color: '#93c5fd',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 6,
                  background: 'rgba(59, 130, 246, 0.08)',
                  padding: '4px 8px',
                  borderRadius: 4,
                  borderLeft: '2px solid #3b82f6',
                  marginTop: 2,
                }}>
                  <div>
                    <strong style={{ color: '#60a5fa' }}>Folder Status & What Has Been Done: </strong>
                    {activeItem.audit.whatHasBeenDone}
                  </div>
                </div>
              )}

              {/* Items Already In Folder */}
              {activeItem.audit.existingItems && activeItem.audit.existingItems.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', fontSize: 10.5, color: 'var(--text-dim)' }}>
                  <span>Already in folder:</span>
                  {activeItem.audit.existingItems.slice(0, 10).map((it) => (
                    <span key={it} style={{ background: 'rgba(255, 255, 255, 0.05)', padding: '1px 5px', borderRadius: 3, fontFamily: 'var(--font-mono)' }}>{it}</span>
                  ))}
                  {activeItem.audit.existingItems.length > 10 && (
                    <span>+{activeItem.audit.existingItems.length - 10} more</span>
                  )}
                </div>
              )}

              {/* Way Forward from LLM */}
              {activeItem.audit.wayForward && (
                <div style={{
                  fontSize: 11.5,
                  color: 'var(--text-muted)',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 6,
                  background: 'rgba(0, 0, 0, 0.25)',
                  padding: '4px 8px',
                  borderRadius: 4,
                  marginTop: 2,
                }}>
                  <CornerDownRight size={13} color="var(--accent-cyan)" style={{ marginTop: 2, flexShrink: 0 }} />
                  <div>
                    <strong style={{ color: 'var(--accent-cyan)' }}>Way Forward from AI: </strong>
                    {activeItem.audit.wayForward}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Suggested Next Commands */}
          {activeItem.audit.suggestedNextCommands?.length > 0 && onRunCustomCommand && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {activeItem.audit.suggestedNextCommands.map((cmd) => (
                <button
                  key={cmd}
                  className="send-btn"
                  style={{ padding: '3px 8px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}
                  onClick={() => onRunCustomCommand(cmd)}
                  title={`Execute dependent command: ${cmd}`}
                >
                  <Play size={10} />
                  <span>Run: {cmd}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* In-Place Interruption Prompt Modal */}
      {isInterruptModalOpen && (
        <div className="interrupt-overlay">
          <div className="interrupt-modal">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Pause size={16} color="var(--accent-amber)" />
                <span style={{ fontWeight: 700, fontSize: 14 }}>System Paused on Your Command</span>
              </div>
              <button
                className="icon-btn"
                onClick={() => setIsInterruptModalOpen(false)}
                style={{ fontSize: 12 }}
              >
                ✕
              </button>
            </div>

            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 12px 0', lineHeight: 1.5 }}>
              Execution is paused. Provide new instructions, corrections, or updated context. The LLM will audit your input, revise the plan and way forward, and continue smoothly.
            </p>

            <textarea
              className="ai-textarea"
              style={{ minHeight: 80, marginBottom: 12 }}
              placeholder="e.g. Wait, make sure to use SQLite instead of MySQL, or add Tailwind CSS..."
              value={interruptNote}
              onChange={(e) => setInterruptNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendInterruptFeedback();
                }
              }}
              autoFocus
            />

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                className="btn-skip-phase"
                onClick={() => {
                  setIsInterruptModalOpen(false);
                  onResume();
                }}
              >
                Resume Without Changes
              </button>
              <button
                className="btn-proceed-phase"
                onClick={handleSendInterruptFeedback}
                disabled={!interruptNote.trim()}
              >
                <Sparkles size={12} />
                <span>Update AI & Revise Plan</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
