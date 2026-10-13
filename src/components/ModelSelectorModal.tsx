import React, { useState } from 'react';
import type { LocalModel, SystemMemory } from '../types';
import {
  Cpu,
  Check,
  Zap,
  X,
  PowerOff,
  RefreshCw,
  Search,
} from 'lucide-react';
import { unloadModel, unloadAllModels, switchModelClean, bootModelStream } from '../services/api';
import { showSuccessToast, showErrorAlert, showInfoToast } from '../services/alerts';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  models: LocalModel[];
  selectedModel: string;
  onSelectModel: (modelName: string) => void;
  fastPilotModel?: string;
  isFastPilotEnabled?: boolean;
  onSelectFastPilotModel?: (modelName: string) => void;
  onToggleFastPilot?: (enabled: boolean) => void;
  systemMemory: SystemMemory | null;
  onRefresh: () => void;
}

export const ModelSelectorModal: React.FC<Props> = ({
  isOpen,
  onClose,
  models,
  selectedModel,
  onSelectModel,
  fastPilotModel = '',
  isFastPilotEnabled = false,
  onSelectFastPilotModel,
  onToggleFastPilot,
  systemMemory,
  onRefresh,
}) => {
  const [filterTab, setFilterTab] = useState<'all' | 'active' | 'fast'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [offloadingModel, setOffloadingModel] = useState<string | null>(null);
  const [isOffloadingAll, setIsOffloadingAll] = useState(false);
  const [switchingTarget, setSwitchingTarget] = useState<string | null>(null);
  const [switchStatusMessage, setSwitchStatusMessage] = useState<string>('');
  const [bootingModel, setBootingModel] = useState<string | null>(null);
  const [bootPercent, setBootPercent] = useState<number>(0);
  const [bootStage, setBootStage] = useState<string>('');

  if (!isOpen) return null;

  const activeModelsInRam = models.filter((m) => m.isLoadedInRam);
  const lightweightModels = models
    .filter((m) => parseFloat(m.sizeGB) <= 1.8)
    .sort((a, b) => parseFloat(a.sizeGB) - parseFloat(b.sizeGB));

  const totalLoadedRamGB = activeModelsInRam
    .reduce((acc, m) => {
      const gb = m.loadedDetails?.ramGB ? parseFloat(m.loadedDetails.ramGB) : parseFloat(m.sizeGB);
      return acc + (isNaN(gb) ? 0 : gb);
    }, 0)
    .toFixed(2);

  const filteredModels = models.filter((model) => {
    if (filterTab === 'active' && !model.isLoadedInRam) return false;
    if (filterTab === 'fast' && parseFloat(model.sizeGB) > 1.8) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        model.name.toLowerCase().includes(q) ||
        model.family.toLowerCase().includes(q) ||
        model.parameterSize.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const handleCopyPullCommand = (cmd: string) => {
    navigator.clipboard.writeText(cmd);
    showSuccessToast(`Copied to clipboard: "${cmd}"`);
  };

  // Handle single model offload
  const handleOffloadSingle = async (e: React.MouseEvent, modelName: string) => {
    e.stopPropagation();
    try {
      setOffloadingModel(modelName);
      showInfoToast(`Offloading ${modelName} from RAM...`);
      const result = await unloadModel(modelName);
      if (result.verified) {
        showSuccessToast(`Model ${modelName} successfully offloaded from RAM.`);
      }
      onRefresh();
    } catch (err: any) {
      console.error('Failed to offload model:', err);
      showErrorAlert('Offload Failed', err.message || 'Could not offload model from RAM');
    } finally {
      setOffloadingModel(null);
    }
  };

  // Handle offload all models
  const handleOffloadAll = async () => {
    if (activeModelsInRam.length === 0) return;
    try {
      setIsOffloadingAll(true);
      showInfoToast(`Offloading all ${activeModelsInRam.length} models from RAM...`);
      const result = await unloadAllModels();
      if (result.verified) {
        showSuccessToast(`All models offloaded. RAM is completely free.`);
      }
      onRefresh();
    } catch (err: any) {
      console.error('Failed to offload all models:', err);
      showErrorAlert('Eject All Failed', err.message || 'Could not offload models');
    } finally {
      setIsOffloadingAll(false);
    }
  };

  // Handle manual boot of model into RAM
  const handleManualBootSingle = async (e: React.MouseEvent, modelName: string) => {
    e.stopPropagation();
    try {
      setBootingModel(modelName);
      setBootPercent(10);
      setBootStage(`Preparing to boot ${modelName}...`);
      showInfoToast(`Waking up ${modelName} into RAM...`);

      const result = await bootModelStream(modelName, (p) => {
        setBootPercent(p.percent);
        setBootStage(p.message);
      });

      if (result.verified || result.success) {
        showSuccessToast(`Model ${modelName} is now active in RAM!`);
        onSelectModel(modelName);
        onRefresh();
      } else {
        throw new Error(`Failed to verify ${modelName} in RAM`);
      }
    } catch (err: any) {
      console.error('Failed to boot model:', err);
      showErrorAlert('Boot Failed', err.message || 'Could not boot model into RAM');
    } finally {
      setBootingModel(null);
      setBootPercent(0);
      setBootStage('');
    }
  };

  // Handle clean model selection & switch
  const handleSelectAndSwitch = async (modelName: string) => {
    if (modelName === selectedModel) {
      onClose();
      return;
    }

    try {
      setSwitchingTarget(modelName);

      // Check if any other models are currently resident in RAM
      const otherActive = activeModelsInRam.filter((m) => m.name !== modelName);
      if (otherActive.length > 0) {
        const names = otherActive.map((m) => m.name).join(', ');
        setSwitchStatusMessage(`Offloading ${names} from RAM to prevent memory overlap...`);
        const result = await switchModelClean(modelName, selectedModel);
        if (result.verified) {
          setSwitchStatusMessage(`RAM verified clean. Activating ${modelName}...`);
          showSuccessToast(`Switched to ${modelName}. Previous models verified offloaded.`);
        }
      } else {
        showSuccessToast(`Active model set to ${modelName}.`);
      }

      onSelectModel(modelName);
      onRefresh();
      setTimeout(() => {
        onClose();
      }, 400);
    } catch (err: any) {
      console.error('Failed to switch model cleanly:', err);
      showErrorAlert('Model Switch Failed', err.message || 'Failed to switch model');
    } finally {
      setSwitchingTarget(null);
      setSwitchStatusMessage('');
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="model-modal"
        style={{ width: 760, maxHeight: '90vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                background: 'rgba(0, 240, 255, 0.1)',
                border: '1px solid rgba(0, 240, 255, 0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Cpu size={20} color="var(--accent-cyan)" />
            </div>
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: '#fff' }}>
                Local LLM Manager & RAM Conservator
              </h2>
              <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: '2px 0 0' }}>
                Track resident memory footprints, offload idle models, and switch cleanly without RAM spikes.
              </p>
            </div>
          </div>
          <button className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* Hardware & Active Memory Status Bar */}
        {systemMemory && (
          <div
            style={{
              padding: '12px 20px',
              background: 'rgba(0, 0, 0, 0.35)',
              borderBottom: '1px solid var(--border-color)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: 12,
              flexWrap: 'wrap',
              gap: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <div>
                <span style={{ color: 'var(--text-dim)' }}>Total RAM: </span>
                <strong style={{ color: 'var(--text-main)' }}>{systemMemory.totalGB} GB</strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-dim)' }}>Used: </span>
                <strong style={{ color: 'var(--text-main)' }}>
                  {systemMemory.usedGB} GB ({systemMemory.usedPercent}%)
                </strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-dim)' }}>Free for LLM: </span>
                <strong style={{ color: 'var(--accent-emerald)' }}>
                  {systemMemory.availableGB} GB
                </strong>
              </div>
              {activeModelsInRam.length > 0 && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    background: 'rgba(16, 185, 129, 0.15)',
                    padding: '2px 8px',
                    borderRadius: 6,
                    border: '1px solid rgba(16, 185, 129, 0.3)',
                  }}
                >
                  <span className="pulsing-green-dot" />
                  <span style={{ color: '#10b981', fontWeight: 600 }}>
                    In RAM: {totalLoadedRamGB} GB ({activeModelsInRam.length} model
                    {activeModelsInRam.length > 1 ? 's' : ''})
                  </span>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {activeModelsInRam.length > 0 && (
                <button
                  className="btn-offload-ram"
                  onClick={handleOffloadAll}
                  disabled={isOffloadingAll}
                  title="Unload all active models to free RAM"
                >
                  <PowerOff size={13} />
                  <span>{isOffloadingAll ? 'Offloading All...' : 'Offload All RAM'}</span>
                </button>
              )}
              <button
                className="icon-btn"
                style={{ fontSize: 11, padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 6 }}
                onClick={onRefresh}
                title="Refresh hardware and scanning engine"
              >
                <RefreshCw size={12} />
                <span>Refresh</span>
              </button>
            </div>
          </div>
        )}

        {/* Switching / Offloading In-Progress Banner */}
        {switchingTarget && (
          <div
            style={{
              padding: '10px 20px',
              background: 'linear-gradient(90deg, rgba(0, 240, 255, 0.15), rgba(168, 85, 247, 0.15))',
              borderBottom: '1px solid rgba(0, 240, 255, 0.3)',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              fontSize: 12,
              color: 'var(--accent-cyan)',
            }}
          >
            <RefreshCw size={16} className="spin-animation" style={{ animation: 'spin 1s linear infinite' }} />
            <div>
              <strong>Safely Switching Model:</strong> {switchStatusMessage || `Preparing ${switchingTarget}...`}
            </div>
          </div>
        )}

        {/* Dual-Engine Fast Pilot Architecture Banner & Controls */}
        <div
          style={{
            padding: '12px 20px',
            background: isFastPilotEnabled ? 'rgba(234, 179, 8, 0.07)' : 'rgba(255, 255, 255, 0.02)',
            borderBottom: '1px solid var(--border-color)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  background: 'rgba(234, 179, 8, 0.15)',
                  border: '1px solid rgba(234, 179, 8, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Zap size={16} color="#facc15" />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#facc15' }}>
                  Dual-Engine Architecture (Fast Pilot + Heavy Architect)
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                  Offloads intent interpretation & quick step routing to an ultra-fast sub-1GB model, while the primary model handles deep planning & code synthesis.
                </div>
              </div>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, fontWeight: 600, color: '#fff' }}>
              <input
                type="checkbox"
                checked={!!isFastPilotEnabled}
                onChange={(e) => onToggleFastPilot?.(e.target.checked)}
                style={{ cursor: 'pointer', accentColor: '#facc15', width: 15, height: 15 }}
              />
              Enable Fast Pilot
            </label>
          </div>

          {isFastPilotEnabled && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
                background: 'rgba(0, 0, 0, 0.3)',
                padding: '8px 12px',
                borderRadius: 8,
                border: '1px solid rgba(234, 179, 8, 0.2)',
              }}
            >
              <span style={{ fontSize: 12, color: 'var(--text-dim)', fontWeight: 500 }}>Active Fast Pilot:</span>
              {lightweightModels.length > 0 ? (
                <select
                  value={fastPilotModel}
                  onChange={(e) => onSelectFastPilotModel?.(e.target.value)}
                  style={{
                    background: '#18181b',
                    color: '#facc15',
                    border: '1px solid rgba(234, 179, 8, 0.4)',
                    borderRadius: 6,
                    padding: '4px 10px',
                    fontSize: 12,
                    fontWeight: 600,
                    outline: 'none',
                    cursor: 'pointer',
                  }}
                >
                  {lightweightModels.map((m) => (
                    <option key={m.name} value={m.name} style={{ background: '#18181b', color: '#fff' }}>
                      ⚡ {m.name} ({m.sizeGB} GB{parseFloat(m.sizeGB) <= 1.0 ? ' - <1GB' : ''})
                    </option>
                  ))}
                </select>
              ) : (
                <span style={{ fontSize: 12, color: '#ef4444' }}>
                  No models &lt; 1.8GB installed yet. Click a quick pull below!
                </span>
              )}

              {/* Quick Pull Suggestions */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Recommended &lt;1GB:</span>
                {[
                  { name: 'qwen2.5-coder:0.5b', size: '390MB' },
                  { name: 'deepseek-coder:1.3b', size: '776MB' },
                  { name: 'smollm2:360m', size: '230MB' },
                ].map((rec) => {
                  const isInstalled = models.some((m) => m.name === rec.name);
                  return (
                    <button
                      key={rec.name}
                      onClick={() => handleCopyPullCommand(`ollama pull ${rec.name}`)}
                      style={{
                        fontSize: 10,
                        background: isInstalled ? 'rgba(16, 185, 129, 0.15)' : 'rgba(255, 255, 255, 0.08)',
                        border: '1px solid',
                        borderColor: isInstalled ? 'rgba(16, 185, 129, 0.4)' : 'rgba(255, 255, 255, 0.15)',
                        color: isInstalled ? '#10b981' : '#ddd',
                        padding: '2px 8px',
                        borderRadius: 4,
                        cursor: 'pointer',
                      }}
                      title={isInstalled ? `Installed (${rec.size})` : `Click to copy 'ollama pull ${rec.name}' (${rec.size})`}
                    >
                      {isInstalled ? `✓ ${rec.name}` : `+ ${rec.name} (${rec.size})`}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Search & Tabs Toolbar */}
        <div
          style={{
            padding: '10px 20px',
            borderBottom: '1px solid var(--border-color)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            background: 'rgba(255, 255, 255, 0.02)',
          }}
        >
          {/* Tabs */}
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => setFilterTab('all')}
              style={{
                background: filterTab === 'all' ? 'rgba(255, 255, 255, 0.1)' : 'transparent',
                color: filterTab === 'all' ? '#fff' : 'var(--text-dim)',
                border: '1px solid',
                borderColor: filterTab === 'all' ? 'var(--border-color)' : 'transparent',
                borderRadius: 6,
                padding: '4px 12px',
                fontSize: 12,
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              All Models ({models.length})
            </button>
            <button
              onClick={() => setFilterTab('active')}
              style={{
                background: filterTab === 'active' ? 'rgba(16, 185, 129, 0.15)' : 'transparent',
                color: filterTab === 'active' ? '#10b981' : 'var(--text-dim)',
                border: '1px solid',
                borderColor: filterTab === 'active' ? 'rgba(16, 185, 129, 0.4)' : 'transparent',
                borderRadius: 6,
                padding: '4px 12px',
                fontSize: 12,
                cursor: 'pointer',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              {activeModelsInRam.length > 0 && <span className="pulsing-green-dot" />}
              <span>Loaded in RAM ({activeModelsInRam.length})</span>
            </button>
            <button
              onClick={() => setFilterTab('fast')}
              style={{
                background: filterTab === 'fast' ? 'rgba(234, 179, 8, 0.15)' : 'transparent',
                color: filterTab === 'fast' ? '#facc15' : 'var(--text-dim)',
                border: '1px solid',
                borderColor: filterTab === 'fast' ? 'rgba(234, 179, 8, 0.4)' : 'transparent',
                borderRadius: 6,
                padding: '4px 12px',
                fontSize: 12,
                cursor: 'pointer',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <Zap size={12} color="#facc15" />
              <span>Fast Pilots ({lightweightModels.length})</span>
            </button>
          </div>

          {/* Search box */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'rgba(0, 0, 0, 0.3)',
              border: '1px solid var(--border-color)',
              borderRadius: 6,
              padding: '4px 10px',
              width: 220,
            }}
          >
            <Search size={14} color="var(--text-dim)" />
            <input
              type="text"
              placeholder="Search model or family..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#fff',
                fontSize: 12,
                outline: 'none',
                width: '100%',
              }}
            />
          </div>
        </div>

        {/* Models List */}
        <div className="modal-content" style={{ maxHeight: 'calc(90vh - 180px)' }}>
          {filteredModels.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-dim)' }}>
              {filterTab === 'active' ? (
                <div>
                  <div style={{ fontSize: 24, marginBottom: 8 }}>💤</div>
                  <strong style={{ color: '#fff', fontSize: 14 }}>RAM is completely clean!</strong>
                  <p style={{ fontSize: 12, marginTop: 4 }}>
                    No Ollama models are resident in memory. System RAM is fully preserved.
                  </p>
                </div>
              ) : (
                <div>
                  <p>No models found matching your search.</p>
                  <p style={{ fontSize: 12 }}>
                    Make sure models are downloaded with <code>ollama pull &lt;model&gt;</code>.
                  </p>
                </div>
              )}
            </div>
          ) : (
            filteredModels.map((model) => {
              const isSelected = model.name === selectedModel;
              const isLoaded = !!model.isLoadedInRam;
              const isBusyOffloading = offloadingModel === model.name;
              const isTargetOfSwitch = switchingTarget === model.name;
              const ram = model.ramEstimate;
              const loadedRamGB = model.loadedDetails?.ramGB || model.sizeGB;

              return (
                <React.Fragment key={model.name}>
                  <div
                    className={`model-card ${isSelected ? 'selected' : ''} ${isLoaded ? 'loaded-in-ram' : ''}`}
                    onClick={() => handleSelectAndSwitch(model.name)}
                  >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                    {/* Header Row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>
                        {model.name}
                      </span>

                      {/* Active Selection Badge */}
                      {isSelected && (
                        <span
                          style={{
                            fontSize: 10,
                            background: 'rgba(0, 240, 255, 0.2)',
                            color: 'var(--accent-cyan)',
                            border: '1px solid rgba(0, 240, 255, 0.4)',
                            padding: '2px 6px',
                            borderRadius: 4,
                            fontWeight: 700,
                          }}
                        >
                          ACTIVE TARGET
                        </span>
                      )}

                      {/* Loaded in RAM Status Badge */}
                      {isLoaded ? (
                        <span className="badge badge-ram-active">
                          <span className="pulsing-green-dot" />
                          <span>LOADED IN RAM ({loadedRamGB} GB)</span>
                        </span>
                      ) : (
                        <span className="badge badge-dormant">
                          <span>DORMANT ON DISK</span>
                        </span>
                      )}

                      {/* Safety Badge */}
                      <span
                        className={`badge ${
                          model.safetyBadge === 'SAFE'
                            ? 'badge-safe'
                            : model.safetyBadge === 'TIGHT'
                            ? 'badge-tight'
                            : 'badge-heavy'
                        }`}
                      >
                        {model.safetyBadge === 'SAFE' && '🟢 Safe & Fast'}
                        {model.safetyBadge === 'TIGHT' && '🟡 Tight RAM'}
                        {model.safetyBadge === 'SWAP_HEAVY' && '🔴 High Swap Risk'}
                      </span>

                      {/* Fast Pilot Badge */}
                      {model.name === fastPilotModel && isFastPilotEnabled && (
                        <span
                          style={{
                            fontSize: 10,
                            background: 'rgba(234, 179, 8, 0.2)',
                            color: '#facc15',
                            border: '1px solid rgba(234, 179, 8, 0.4)',
                            padding: '2px 6px',
                            borderRadius: 4,
                            fontWeight: 700,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                          }}
                        >
                          <Zap size={10} color="#facc15" />
                          <span>FAST PILOT</span>
                        </span>
                      )}

                      {/* <1GB Lightweight Badge */}
                      {parseFloat(model.sizeGB) <= 1.0 && (
                        <span
                          style={{
                            fontSize: 10,
                            background: 'rgba(16, 185, 129, 0.12)',
                            color: '#10b981',
                            border: '1px solid rgba(16, 185, 129, 0.3)',
                            padding: '2px 6px',
                            borderRadius: 4,
                            fontWeight: 600,
                          }}
                        >
                          ⚡ &lt;1GB LIGHTWEIGHT
                        </span>
                      )}
                    </div>

                    {/* Metadata specs */}
                    <div
                      style={{
                        display: 'flex',
                        gap: 16,
                        fontSize: 12,
                        color: 'var(--text-dim)',
                        flexWrap: 'wrap',
                      }}
                    >
                      <span>
                        Parameters: <strong style={{ color: 'var(--text-main)' }}>{model.parameterSize}</strong>
                      </span>
                      <span>
                        Quant: <strong style={{ color: 'var(--text-main)' }}>{model.quantization}</strong>
                      </span>
                      <span>
                        Disk Size: <strong style={{ color: 'var(--text-main)' }}>{model.sizeGB} GB</strong>
                      </span>
                      <span>
                        Format: <strong style={{ color: 'var(--text-main)' }}>{model.format}</strong>
                      </span>
                      {model.loadedDetails?.expiresAt && (
                        <span title={model.loadedDetails.expiresAt}>
                          Keep-alive: <strong style={{ color: '#10b981' }}>Resident</strong>
                        </span>
                      )}
                    </div>

                    {/* RAM breakdown */}
                    <div
                      style={{
                        display: 'flex',
                        gap: 12,
                        marginTop: 4,
                        fontSize: 11,
                        fontFamily: 'var(--font-mono)',
                        background: 'rgba(0, 0, 0, 0.25)',
                        padding: '4px 10px',
                        borderRadius: 6,
                        width: 'fit-content',
                      }}
                    >
                      <span style={{ color: 'var(--text-muted)' }}>
                        Est. RAM:{' '}
                        <strong style={{ color: isLoaded ? '#10b981' : 'var(--accent-cyan)' }}>
                          {ram.totalEstimatedGB} GB
                        </strong>
                      </span>
                      <span style={{ color: 'var(--text-dim)' }}>
                        (Weights: {ram.weightsGB} GB + KV Cache: {ram.kvCacheGB} GB + Buffer: {ram.runtimeBufferGB} GB)
                      </span>
                    </div>
                  </div>

                  {/* Actions Column */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    {/* Offload from RAM Button */}
                    {isLoaded && (
                      <button
                        className="btn-offload-ram"
                        disabled={isBusyOffloading || isTargetOfSwitch || bootingModel === model.name}
                        onClick={(e) => handleOffloadSingle(e, model.name)}
                        title="Unload this model from RAM to reclaim system memory"
                      >
                        <PowerOff size={13} />
                        <span>{isBusyOffloading ? 'Offloading...' : 'Offload RAM'}</span>
                      </button>
                    )}

                    {/* Manual Boot into RAM Button */}
                    {!isLoaded && (
                      <button
                        className="btn-boot-ram"
                        disabled={bootingModel === model.name || isTargetOfSwitch}
                        onClick={(e) => handleManualBootSingle(e, model.name)}
                        title="Manually wake up and boot this model into RAM now"
                      >
                        {bootingModel === model.name ? (
                          <RefreshCw size={13} style={{ animation: 'spin 1s linear infinite' }} />
                        ) : (
                          <Zap size={13} />
                        )}
                        <span>
                          {bootingModel === model.name
                            ? `Booting (${bootPercent}%)...`
                            : '⚡ Boot into RAM'}
                        </span>
                      </button>
                    )}

                    {/* Set as Fast Pilot Button */}
                    {parseFloat(model.sizeGB) <= 1.8 && (
                      <button
                        style={{
                          background: model.name === fastPilotModel && isFastPilotEnabled ? 'rgba(234, 179, 8, 0.25)' : 'rgba(255, 255, 255, 0.08)',
                          border: '1px solid',
                          borderColor: model.name === fastPilotModel && isFastPilotEnabled ? '#facc15' : 'rgba(255, 255, 255, 0.15)',
                          color: model.name === fastPilotModel && isFastPilotEnabled ? '#facc15' : 'var(--text-dim)',
                          fontSize: 11,
                          padding: '5px 10px',
                          borderRadius: 6,
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 5,
                          fontWeight: 600,
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectFastPilotModel?.(model.name);
                          if (!isFastPilotEnabled) onToggleFastPilot?.(true);
                        }}
                        title="Set this model as the Fast Pilot router"
                      >
                        <Zap size={12} color={model.name === fastPilotModel && isFastPilotEnabled ? '#facc15' : undefined} />
                        <span>{model.name === fastPilotModel && isFastPilotEnabled ? 'Active Pilot' : 'Use as Pilot'}</span>
                      </button>
                    )}

                    {/* Select / Switch Button */}
                    <button
                      className="send-btn"
                      disabled={isTargetOfSwitch || bootingModel === model.name}
                      style={{
                        padding: '6px 14px',
                        background: isSelected
                          ? 'rgba(0, 240, 255, 0.2)'
                          : 'rgba(255, 255, 255, 0.08)',
                        color: isSelected ? 'var(--accent-cyan)' : '#fff',
                        border: isSelected
                          ? '1px solid var(--accent-cyan)'
                          : '1px solid var(--border-color)',
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSelectAndSwitch(model.name);
                      }}
                    >
                      {isTargetOfSwitch ? (
                        <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} />
                      ) : isSelected ? (
                        <Check size={14} />
                      ) : (
                        <Zap size={14} />
                      )}
                      <span>
                        {isTargetOfSwitch
                          ? 'Switching...'
                          : isSelected
                          ? 'Selected'
                          : 'Use Model'}
                      </span>
                    </button>
                  </div>
                </div>

                {/* Live Mini Progress Bar on Card if Booting */}
                {bootingModel === model.name && (
                  <div
                    style={{
                      width: '100%',
                      padding: '8px 14px',
                      background: 'rgba(0, 240, 255, 0.06)',
                      borderRadius: 8,
                      border: '1px solid rgba(0, 240, 255, 0.25)',
                      marginTop: -4,
                      marginBottom: 8,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontSize: 11,
                        marginBottom: 4,
                        color: '#00f0ff',
                      }}
                    >
                      <span>{bootStage || 'Booting model weights into RAM...'}</span>
                      <span style={{ fontWeight: 700 }}>{bootPercent}%</span>
                    </div>
                    <div
                      style={{
                        height: 6,
                        background: 'rgba(255, 255, 255, 0.1)',
                        borderRadius: 3,
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          width: `${bootPercent}%`,
                          background: 'linear-gradient(90deg, #00f0ff, #8b5cf6)',
                          transition: 'width 0.3s ease',
                        }}
                      />
                    </div>
                  </div>
                )}
              </React.Fragment>
            );
          })
          )}
        </div>
      </div>
    </div>
  );
};
