import React from 'react';
import { Cpu, CheckCircle2, Clock, Sparkles } from 'lucide-react';

interface Props {
  isOpen: boolean;
  modelName: string;
  percent: number;
  stageMessage: string;
  isCompleted?: boolean;
  ramEstimate?: string | number;
  isAutonomousTrigger?: boolean;
}

export const ModelBootHUD: React.FC<Props> = ({
  isOpen,
  modelName,
  percent,
  stageMessage,
  isCompleted = false,
  ramEstimate,
  isAutonomousTrigger = false,
}) => {
  if (!isOpen) return null;

  const steps = [
    { label: 'RAM Prep', min: 10 },
    { label: 'Allocate', min: 25 },
    { label: 'Load Weights', min: 55 },
    { label: 'Warmup', min: 85 },
    { label: 'Online', min: 100 },
  ];

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(5, 7, 15, 0.75)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        animation: 'fadeIn 0.25s ease-out',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 540,
          background: 'linear-gradient(145deg, rgba(17, 24, 39, 0.95), rgba(10, 15, 29, 0.98))',
          border: isCompleted ? '1px solid rgba(16, 185, 129, 0.5)' : '1px solid rgba(0, 240, 255, 0.35)',
          boxShadow: isCompleted
            ? '0 20px 50px rgba(16, 185, 129, 0.25), 0 0 30px rgba(16, 185, 129, 0.15)'
            : '0 20px 50px rgba(0, 240, 255, 0.2), 0 0 40px rgba(139, 92, 246, 0.15)',
          borderRadius: 16,
          padding: '28px 32px',
          color: 'var(--text-main, #f3f4f6)',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Top Decorative Glow Line */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 3,
            background: isCompleted
              ? 'linear-gradient(90deg, #10b981, #34d399)'
              : 'linear-gradient(90deg, #00f0ff, #8b5cf6, #ec4899)',
          }}
        />

        {/* Header Icon + Title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 14,
              background: isCompleted
                ? 'rgba(16, 185, 129, 0.15)'
                : 'linear-gradient(135deg, rgba(0, 240, 255, 0.15), rgba(139, 92, 246, 0.15))',
              border: isCompleted ? '1px solid rgba(16, 185, 129, 0.4)' : '1px solid rgba(0, 240, 255, 0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: isCompleted ? '#10b981' : '#00f0ff',
              flexShrink: 0,
              boxShadow: isCompleted ? '0 0 20px rgba(16, 185, 129, 0.3)' : '0 0 20px rgba(0, 240, 255, 0.25)',
            }}
          >
            {isCompleted ? <CheckCircle2 size={28} /> : <Cpu size={28} className="spin-slow" />}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 800,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  padding: '2px 8px',
                  borderRadius: 6,
                  background: isCompleted ? 'rgba(16, 185, 129, 0.2)' : 'rgba(0, 240, 255, 0.15)',
                  color: isCompleted ? '#34d399' : '#00f0ff',
                  border: isCompleted ? '1px solid rgba(16, 185, 129, 0.3)' : '1px solid rgba(0, 240, 255, 0.3)',
                }}
              >
                {isCompleted ? 'Engine Online' : 'Waking Up Engine'}
              </span>
              {ramEstimate && (
                <span
                  style={{
                    fontSize: 10,
                    color: 'var(--text-dim, #9ca3af)',
                    background: 'rgba(255, 255, 255, 0.05)',
                    padding: '2px 6px',
                    borderRadius: 4,
                  }}
                >
                  Est. {ramEstimate} GB RAM
                </span>
              )}
            </div>

            <h3
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: '#fff',
                margin: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span>{modelName}</span>
            </h3>
          </div>
        </div>

        {/* Requirement 3 Notification Notice */}
        <div
          style={{
            background: isCompleted
              ? 'rgba(16, 185, 129, 0.08)'
              : 'rgba(59, 130, 246, 0.08)',
            border: isCompleted
              ? '1px solid rgba(16, 185, 129, 0.25)'
              : '1px solid rgba(59, 130, 246, 0.25)',
            borderRadius: 10,
            padding: '10px 14px',
            fontSize: 12,
            lineHeight: 1.5,
            color: isCompleted ? '#a7f3d0' : '#93c5fd',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
          }}
        >
          {isCompleted ? (
            <Sparkles size={16} style={{ marginTop: 2, flexShrink: 0, color: '#34d399' }} />
          ) : (
            <Clock size={16} style={{ marginTop: 2, flexShrink: 0, color: '#60a5fa' }} />
          )}
          <div>
            {isCompleted ? (
              <span>
                <strong>Model is fully booted and verified in RAM!</strong> Execution is starting immediately...
              </span>
            ) : isAutonomousTrigger ? (
              <span>
                <strong>Please wait:</strong> The LLM is waking up and booting into RAM. Execution of your task has <em>not begun yet</em> and will start automatically as soon as the engine is ready.
              </span>
            ) : (
              <span>
                <strong>Please wait:</strong> Loading model tensor weights from disk into memory. System will verify active presence before execution starts.
              </span>
            )}
          </div>
        </div>

        {/* Progress Bar Section */}
        <div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 8,
              fontSize: 12,
            }}
          >
            <span
              style={{
                color: isCompleted ? '#34d399' : 'var(--text-main, #e5e7eb)',
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: '80%',
              }}
            >
              {stageMessage || (isCompleted ? 'Model active and ready' : 'Booting model...')}
            </span>
            <span
              style={{
                fontFamily: 'monospace',
                fontWeight: 700,
                color: isCompleted ? '#34d399' : '#00f0ff',
                fontSize: 13,
              }}
            >
              {percent}%
            </span>
          </div>

          {/* Bar track */}
          <div
            style={{
              height: 10,
              background: 'rgba(255, 255, 255, 0.08)',
              borderRadius: 6,
              overflow: 'hidden',
              position: 'relative',
              boxShadow: 'inset 0 1px 3px rgba(0, 0, 0, 0.5)',
            }}
          >
            {/* Fill */}
            <div
              style={{
                height: '100%',
                width: `${Math.min(100, Math.max(0, percent))}%`,
                background: isCompleted
                  ? 'linear-gradient(90deg, #10b981, #34d399)'
                  : 'linear-gradient(90deg, #00f0ff, #8b5cf6, #ec4899)',
                borderRadius: 6,
                transition: 'width 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                boxShadow: isCompleted
                  ? '0 0 12px rgba(16, 185, 129, 0.8)'
                  : '0 0 12px rgba(0, 240, 255, 0.7)',
              }}
            />
          </div>
        </div>

        {/* Step checkpoints */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            paddingTop: 4,
            borderTop: '1px solid rgba(255, 255, 255, 0.06)',
          }}
        >
          {steps.map((step, idx) => {
            const isDone = percent >= step.min;
            const isCurrent = !isDone && (idx === 0 || percent >= steps[idx - 1].min);
            return (
              <div
                key={step.label}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 10,
                  color: isDone ? '#34d399' : isCurrent ? '#00f0ff' : 'rgba(255, 255, 255, 0.3)',
                  fontWeight: isDone || isCurrent ? 600 : 400,
                }}
              >
                <div
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: isDone ? '#10b981' : isCurrent ? '#00f0ff' : 'rgba(255, 255, 255, 0.15)',
                    boxShadow: isDone || isCurrent ? '0 0 6px currentColor' : 'none',
                    transition: 'all 0.3s ease',
                  }}
                />
                <span>{step.label}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
