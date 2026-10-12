import React from 'react';
import type { PlanTask } from '../types';
import { CheckSquare, Square, ListTodo, Play, CheckCircle2 } from 'lucide-react';

interface Props {
  plan: PlanTask[];
  onToggleTask: (taskId: string) => void;
  onExecutePlan: () => void;
  isExecuting?: boolean;
}

export const PlanDrawer: React.FC<Props> = ({ plan, onToggleTask, onExecutePlan, isExecuting }) => {
  if (plan.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-dim)', fontSize: 13 }}>
        <ListTodo size={32} style={{ margin: '0 auto 10px', opacity: 0.4 }} />
        <p>No active implementation plan.</p>
        <p style={{ fontSize: 11, marginTop: 4 }}>
          Toggle <strong>Plan Mode</strong> in chat or ask the LLM to design an implementation plan.
        </p>
      </div>
    );
  }

  const completedCount = plan.filter((t) => t.completed).length;
  const progressPercent = Math.round((completedCount / plan.length) * 100);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '12px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-main)' }}>
            Implementation Plan ({completedCount}/{plan.length})
          </span>
        </div>
        <button
          className="send-btn"
          style={{ padding: '4px 10px', fontSize: 11 }}
          onClick={onExecutePlan}
          disabled={isExecuting}
        >
          {isExecuting ? <CheckCircle2 size={13} /> : <Play size={13} />}
          {isExecuting ? 'Executing...' : 'Execute Steps'}
        </button>
      </div>

      {/* Progress Bar */}
      <div style={{
        height: 6,
        background: 'rgba(255, 255, 255, 0.08)',
        borderRadius: 3,
        overflow: 'hidden',
        marginBottom: 14,
      }}>
        <div style={{
          height: '100%',
          width: `${progressPercent}%`,
          background: 'linear-gradient(90deg, var(--accent-cyan), var(--accent-violet))',
          transition: 'width 0.3s ease',
        }} />
      </div>

      {/* Task Checklist */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {plan.map((task) => (
          <div
            key={task.id}
            onClick={() => onToggleTask(task.id)}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              padding: '8px 12px',
              borderRadius: 6,
              background: task.completed ? 'rgba(16, 185, 129, 0.05)' : 'rgba(255, 255, 255, 0.03)',
              border: task.completed ? '1px solid rgba(16, 185, 129, 0.2)' : '1px solid var(--border-color)',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
          >
            {task.completed ? (
              <CheckSquare size={16} color="var(--accent-emerald)" style={{ marginTop: 2 }} />
            ) : (
              <Square size={16} color="var(--text-dim)" style={{ marginTop: 2 }} />
            )}
            <div style={{ flex: 1 }}>
              <div style={{
                fontSize: 12.5,
                color: task.completed ? 'var(--text-dim)' : 'var(--text-main)',
                textDecoration: task.completed ? 'line-through' : 'none',
              }}>
                {task.title}
              </div>
              {task.description && (
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                  {task.description}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
