import React from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { Check, X, GitCompare } from 'lucide-react';
import type { DiffProposal } from '../types';

interface Props {
  diff: DiffProposal | null;
  onAccept: (diff: DiffProposal) => void;
  onReject: () => void;
}

export const DiffReviewModal: React.FC<Props> = ({ diff, onAccept, onReject }) => {
  if (!diff) return null;

  return (
    <div className="modal-overlay" onClick={onReject}>
      <div
        className="model-modal"
        style={{ width: '85vw', height: '85vh', maxWidth: 1200 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <GitCompare size={20} color="var(--accent-cyan)" />
            <div>
              <h2 style={{ fontSize: 15, fontWeight: 700 }}>Review File Changes (Applied to Disk)</h2>
              <p style={{ fontSize: 12, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                {diff.filePath} • Changes are applied directly. You can inspect the side-by-side diff or revert below.
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="btn-accept" onClick={() => onAccept(diff)} title="Confirm and keep applied changes">
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Check size={14} /> Keep Changes
              </span>
            </button>
            <button className="btn-reject" onClick={onReject} title="Revert file back to original state">
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <X size={14} /> Revert Changes
              </span>
            </button>
          </div>
        </div>

        <div style={{ flex: 1, position: 'relative' }}>
          <DiffEditor
            height="100%"
            language={diff.filePath.split('.').pop() || 'typescript'}
            original={diff.originalContent}
            modified={diff.modifiedContent}
            theme="vs-dark"
            options={{
              readOnly: true,
              renderSideBySide: true,
              minimap: { enabled: false },
              fontSize: 13,
              fontFamily: "'JetBrains Mono', monospace",
              scrollBeyondLastLine: false,
            }}
          />
        </div>
      </div>
    </div>
  );
};
