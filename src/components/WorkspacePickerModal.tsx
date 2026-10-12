import React, { useState, useEffect } from 'react';
import {
  Folder,
  FolderPlus,
  FolderOpen,
  ArrowUp,
  Check,
  X,
  Sparkles,
  Search,
  Home,
  Layers,
  ChevronRight,
  Clock,
} from 'lucide-react';
import { fetchDirectories, createDirectory } from '../services/api';
import { showSuccessToast, showErrorAlert } from '../services/alerts';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  currentWorkspace: string;
  onSelectWorkspace: (workspacePath: string) => void;
}

interface DirItem {
  name: string;
  path: string;
  hasIdeSession: boolean;
  subItemCount: number;
}

export const WorkspacePickerModal: React.FC<Props> = ({
  isOpen,
  onClose,
  currentWorkspace,
  onSelectWorkspace,
}) => {
  const [browsingPath, setBrowsingPath] = useState<string>(currentWorkspace);
  const [selectedPath, setSelectedPath] = useState<string>(currentWorkspace);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [homePath, setHomePath] = useState<string>('');
  const [directories, setDirectories] = useState<DirItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('ide_recent_workspaces');
      return saved ? JSON.parse(saved) : ['/home/anto/builds/essence', '/home/anto/builds/ide'];
    } catch (e) {
      return ['/home/anto/builds/essence', '/home/anto/builds/ide'];
    }
  });

  const loadPath = async (targetPath?: string) => {
    setLoading(true);
    try {
      const res = await fetchDirectories(targetPath);
      setBrowsingPath(res.currentPath);
      setParentPath(res.parentPath);
      setHomePath(res.homePath);
      setDirectories(res.directories);
      setSelectedPath(res.currentPath);
    } catch (err: any) {
      console.error('Failed to browse directories:', err);
      showErrorAlert('Browse Error', err.message || 'Could not load directory');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadPath(currentWorkspace || undefined);
      setIsCreatingFolder(false);
      setNewFolderName('');
    }
  }, [isOpen, currentWorkspace]);

  const handleSelectAndOpen = (targetPath: string) => {
    // Save to recents
    const updated = [targetPath, ...recentWorkspaces.filter((w) => w !== targetPath)].slice(0, 6);
    setRecentWorkspaces(updated);
    try {
      localStorage.setItem('ide_recent_workspaces', JSON.stringify(updated));
    } catch (e) {}

    onSelectWorkspace(targetPath);
    onClose();
  };

  const handleCreateNewFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFolderName.trim()) return;

    try {
      const res = await createDirectory(browsingPath, newFolderName.trim());
      showSuccessToast(`Created folder "${res.name}"`);
      setIsCreatingFolder(false);
      setNewFolderName('');
      await loadPath(browsingPath);
      setSelectedPath(res.path);
    } catch (err: any) {
      showErrorAlert('Creation Failed', err.message || 'Could not create folder');
    }
  };

  if (!isOpen) return null;

  const filteredDirs = directories.filter((d) =>
    d.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="model-modal"
        style={{ width: '850px', height: '620px', maxWidth: '95vw', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <FolderOpen size={20} color="var(--accent-cyan)" />
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 700 }}>Choose Project Workspace</h2>
              <p style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                Select an existing folder to resume sessions or create a new project directory.
              </p>
            </div>
          </div>
          <button className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* Quick Jump Bar */}
        <div
          style={{
            padding: '8px 16px',
            background: 'rgba(0, 0, 0, 0.25)',
            borderBottom: '1px solid var(--border-color)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 600 }}>QUICK JUMP:</span>
          {homePath && (
            <button
              className="quick-jump-btn"
              onClick={() => loadPath(homePath)}
              title="Go to Home directory"
            >
              <Home size={12} />
              <span>Home</span>
            </button>
          )}
          <button
            className="quick-jump-btn"
            onClick={() => loadPath('/home/anto/builds')}
            title="Go to Builds directory"
          >
            <Layers size={12} />
            <span>Builds</span>
          </button>
          {recentWorkspaces.map((rec) => (
            <button
              key={rec}
              className={`quick-jump-btn ${rec === browsingPath ? 'active' : ''}`}
              onClick={() => loadPath(rec)}
              title={rec}
            >
              <Clock size={11} />
              <span>{rec.split('/').pop()}</span>
            </button>
          ))}
        </div>

        {/* Path Navigation & Actions Bar */}
        <div
          style={{
            padding: '10px 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            background: 'var(--bg-main)',
            borderBottom: '1px solid var(--border-color)',
          }}
        >
          {/* Breadcrumb / Location Bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, overflow: 'hidden' }}>
            {parentPath && (
              <button
                className="icon-btn"
                style={{ padding: 6, background: 'rgba(255, 255, 255, 0.05)', borderRadius: 4 }}
                onClick={() => loadPath(parentPath)}
                title="Go up one folder"
              >
                <ArrowUp size={14} />
              </button>
            )}
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                color: 'var(--text-main)',
                background: 'rgba(0, 0, 0, 0.3)',
                padding: '5px 10px',
                borderRadius: 4,
                border: '1px solid var(--border-color)',
                flex: 1,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {browsingPath}
            </div>
          </div>

          {/* Search Filter & Add Folder Button */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ position: 'relative', width: 180 }}>
              <Search
                size={12}
                style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', opacity: 0.5 }}
              />
              <input
                type="text"
                placeholder="Filter folders..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                  width: '100%',
                  padding: '5px 8px 5px 26px',
                  fontSize: 11,
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 4,
                  color: 'var(--text-main)',
                }}
              />
            </div>

            <button
              className="send-btn"
              style={{ padding: '5px 10px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}
              onClick={() => setIsCreatingFolder((p) => !p)}
            >
              <FolderPlus size={13} />
              <span>Add Folder</span>
            </button>
          </div>
        </div>

        {/* Inline Create Folder Input */}
        {isCreatingFolder && (
          <form
            onSubmit={handleCreateNewFolder}
            style={{
              padding: '8px 16px',
              background: 'rgba(14, 165, 233, 0.08)',
              borderBottom: '1px solid var(--accent-cyan)',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <FolderPlus size={16} color="var(--accent-cyan)" />
            <input
              type="text"
              autoFocus
              placeholder="Enter new folder name (e.g. my-new-app)..."
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              style={{
                flex: 1,
                padding: '6px 10px',
                background: 'rgba(0, 0, 0, 0.4)',
                border: '1px solid var(--border-color)',
                borderRadius: 4,
                color: 'var(--text-main)',
                fontSize: 12,
              }}
            />
            <button
              type="submit"
              className="btn-accept"
              style={{ padding: '5px 12px', fontSize: 11 }}
              disabled={!newFolderName.trim()}
            >
              Create & Select
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setIsCreatingFolder(false)}
            >
              <X size={14} />
            </button>
          </form>
        )}

        {/* Directory List / Explorer Body */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '12px 16px',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: 10,
            alignContent: 'start',
          }}
        >
          {loading ? (
            <div style={{ gridColumn: '1 / -1', padding: 40, textAlign: 'center', color: 'var(--text-dim)' }}>
              Loading folders...
            </div>
          ) : filteredDirs.length === 0 ? (
            <div style={{ gridColumn: '1 / -1', padding: 40, textAlign: 'center', color: 'var(--text-dim)' }}>
              <Folder size={32} style={{ margin: '0 auto 8px', opacity: 0.3 }} />
              <p>No subdirectories in this folder.</p>
              <p style={{ fontSize: 11, marginTop: 4 }}>
                Click "Add Folder" above to create a new workspace project here, or select this folder.
              </p>
            </div>
          ) : (
            filteredDirs.map((dir) => {
              const isSelected = selectedPath === dir.path;
              return (
                <div
                  key={dir.path}
                  onClick={() => setSelectedPath(dir.path)}
                  onDoubleClick={() => loadPath(dir.path)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 12px',
                    borderRadius: 6,
                    background: isSelected
                      ? 'rgba(14, 165, 233, 0.15)'
                      : dir.hasIdeSession
                      ? 'rgba(139, 92, 246, 0.08)'
                      : 'rgba(255, 255, 255, 0.03)',
                    border: isSelected
                      ? '1px solid var(--accent-cyan)'
                      : dir.hasIdeSession
                      ? '1px solid rgba(139, 92, 246, 0.3)'
                      : '1px solid var(--border-color)',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                  title={`Double click to enter folder\nSingle click to select`}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, overflow: 'hidden' }}>
                    <Folder
                      size={18}
                      color={dir.hasIdeSession ? 'var(--accent-violet)' : isSelected ? 'var(--accent-cyan)' : 'var(--text-dim)'}
                    />
                    <div style={{ overflow: 'hidden' }}>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 12.5,
                          color: isSelected ? 'var(--accent-cyan)' : 'var(--text-main)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {dir.name}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                        {dir.subItemCount} items
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {dir.hasIdeSession && (
                      <span
                        className="badge badge-safe"
                        style={{ fontSize: 9, padding: '2px 5px', display: 'flex', alignItems: 'center', gap: 3 }}
                        title="Contains previous session history & plan"
                      >
                        <Sparkles size={9} /> Session
                      </span>
                    )}
                    <button
                      className="icon-btn"
                      style={{ padding: 4 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        loadPath(dir.path);
                      }}
                      title="Navigate into this folder"
                    >
                      <ChevronRight size={14} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Modal Footer */}
        <div
          style={{
            padding: '12px 16px',
            borderTop: '1px solid var(--border-color)',
            background: 'rgba(0, 0, 0, 0.25)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ color: 'var(--text-dim)' }}>Selected:</span>
            <strong style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-cyan)' }}>
              {selectedPath || browsingPath}
            </strong>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button className="btn-reject" onClick={onClose} style={{ padding: '6px 14px' }}>
              Cancel
            </button>
            <button
              className="send-btn"
              style={{ padding: '6px 18px', fontSize: 12, fontWeight: 600 }}
              onClick={() => handleSelectAndOpen(selectedPath || browsingPath)}
            >
              <Check size={14} /> Open Workspace & Restore Session
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
