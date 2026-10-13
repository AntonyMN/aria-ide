import React from 'react';
import type { LocalModel, SystemMemory } from '../types';
import { Cpu, Check, Zap, X } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  models: LocalModel[];
  selectedModel: string;
  onSelectModel: (modelName: string) => void;
  systemMemory: SystemMemory | null;
  onRefresh: () => void;
}

export const ModelSelectorModal: React.FC<Props> = ({
  isOpen,
  onClose,
  models,
  selectedModel,
  onSelectModel,
  systemMemory,
  onRefresh,
}) => {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="model-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Cpu size={20} color="var(--accent-cyan)" />
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 700 }}>Installed Local LLMs & RAM Cost</h2>
              <p style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                Scanned from your computer (Ollama manifests & running daemon).
              </p>
            </div>
          </div>
          <button className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* Hardware Memory Status Banner */}
        {systemMemory && (
          <div style={{
            padding: '12px 20px',
            background: 'rgba(0, 0, 0, 0.25)',
            borderBottom: '1px solid var(--border-color)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 12
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div>
                <span style={{ color: 'var(--text-dim)' }}>Total RAM: </span>
                <strong style={{ color: 'var(--text-main)' }}>{systemMemory.totalGB} GB</strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-dim)' }}>Used: </span>
                <strong style={{ color: 'var(--text-main)' }}>{systemMemory.usedGB} GB ({systemMemory.usedPercent}%)</strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-dim)' }}>Available for LLM: </span>
                <strong style={{ color: 'var(--accent-emerald)' }}>{systemMemory.availableGB} GB</strong>
              </div>
            </div>
            <button className="icon-btn" style={{ fontSize: 11, padding: '4px 8px' }} onClick={onRefresh}>
              Refresh Hardware
            </button>
          </div>
        )}

        <div className="modal-content">
          {models.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-dim)' }}>
              No installed models detected yet. Make sure Ollama has downloaded models (e.g. <code>ollama pull qwen2.5-coder:1.5b</code>).
            </div>
          ) : (
            models.map((model) => {
              const isSelected = model.name === selectedModel;
              const ram = model.ramEstimate;

              return (
                <div
                  key={model.name}
                  className={`model-card ${isSelected ? 'selected' : ''}`}
                  onClick={() => {
                    onSelectModel(model.name);
                    onClose();
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>{model.name}</span>
                      {isSelected && (
                        <span style={{
                          fontSize: 10,
                          background: 'rgba(0, 240, 255, 0.2)',
                          color: 'var(--accent-cyan)',
                          padding: '2px 6px',
                          borderRadius: 4,
                          fontWeight: 600
                        }}>ACTIVE</span>
                      )}
                      <span className={`badge ${
                        model.safetyBadge === 'SAFE'
                          ? 'badge-safe'
                          : model.safetyBadge === 'TIGHT'
                          ? 'badge-tight'
                          : 'badge-heavy'
                      }`}>
                        {model.safetyBadge === 'SAFE' && '🟢 Safe & Fast'}
                        {model.safetyBadge === 'TIGHT' && '🟡 Fits (Tight RAM)'}
                        {model.safetyBadge === 'SWAP_HEAVY' && '🔴 High Swap Risk'}
                      </span>
                    </div>

                    <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--text-dim)' }}>
                      <span>Parameters: <strong>{model.parameterSize}</strong></span>
                      <span>Quant: <strong>{model.quantization}</strong></span>
                      <span>Disk: <strong>{model.sizeGB} GB</strong></span>
                      <span>Source: <strong>{model.source.replace('_', ' ')}</strong></span>
                    </div>

                    {/* RAM breakdown */}
                    <div style={{
                      display: 'flex',
                      gap: 12,
                      marginTop: 4,
                      fontSize: 11,
                      fontFamily: 'var(--font-mono)',
                      background: 'rgba(0, 0, 0, 0.2)',
                      padding: '4px 8px',
                      borderRadius: 6,
                      width: 'fit-content'
                    }}>
                      <span style={{ color: 'var(--text-muted)' }}>
                        Est. RAM: <strong style={{ color: 'var(--accent-cyan)' }}>{ram.totalEstimatedGB} GB</strong>
                      </span>
                      <span style={{ color: 'var(--text-dim)' }}>
                        (Weights: {ram.weightsGB} GB + KV Cache: {ram.kvCacheGB} GB)
                      </span>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button
                      className="send-btn"
                      style={{
                        padding: '6px 14px',
                        background: isSelected ? 'rgba(0, 240, 255, 0.2)' : 'rgba(255, 255, 255, 0.08)',
                        color: isSelected ? 'var(--accent-cyan)' : '#fff',
                        border: isSelected ? '1px solid var(--accent-cyan)' : '1px solid var(--border-color)',
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectModel(model.name);
                        onClose();
                      }}
                    >
                      {isSelected ? <Check size={14} /> : <Zap size={14} />}
                      {isSelected ? 'Selected' : 'Use Model'}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
