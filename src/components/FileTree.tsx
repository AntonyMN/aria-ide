import React, { useState } from 'react';
import type { FileNode } from '../types';
import {
  Folder,
  FolderOpen,
  FileCode,
  FileText,
  FileJson,
  FileSpreadsheet,
  File,
  ChevronRight,
  ChevronDown,
  Plus,
  Trash2,
  Edit2,
  RefreshCw,
} from 'lucide-react';

interface Props {
  tree: FileNode[];
  activeFilePath?: string;
  onSelectFile: (filePath: string) => void;
  onCreateItem: (parentPath: string, isDirectory: boolean) => void;
  onDeleteItem: (targetPath: string) => void;
  onRenameItem: (targetPath: string) => void;
  onRefresh: () => void;
  currentRoot: string;
  width?: number;
}

const getFileIcon = (fileName: string) => {
  const ext = fileName.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'rs':
    case 'py':
      return <FileCode size={15} color="#00f0ff" />;
    case 'json':
      return <FileJson size={15} color="#f59e0b" />;
    case 'md':
      return <FileText size={15} color="#a855f7" />;
    case 'css':
    case 'scss':
      return <FileSpreadsheet size={15} color="#3b82f6" />;
    default:
      return <File size={15} color="#94a3b8" />;
  }
};

const TreeNode: React.FC<{
  node: FileNode;
  depth: number;
  activeFilePath?: string;
  onSelectFile: (filePath: string) => void;
  onCreateItem: (parentPath: string, isDirectory: boolean) => void;
  onDeleteItem: (targetPath: string) => void;
  onRenameItem: (targetPath: string) => void;
}> = ({ node, depth, activeFilePath, onSelectFile, onCreateItem, onDeleteItem, onRenameItem }) => {
  const [isOpen, setIsOpen] = useState(depth === 0 || depth === 1);
  const isSelected = activeFilePath === node.path;

  const handleClick = () => {
    if (node.isDirectory) {
      setIsOpen(!isOpen);
    } else {
      onSelectFile(node.path);
    }
  };

  return (
    <div>
      <div
        className={`tree-item ${isSelected ? 'active' : ''}`}
        style={{ paddingLeft: `${12 + depth * 14}px` }}
        onClick={handleClick}
      >
        {node.isDirectory ? (
          <>
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {isOpen ? <FolderOpen size={15} color="#3b82f6" /> : <Folder size={15} color="#3b82f6" />}
          </>
        ) : (
          <>
            <span style={{ width: 14 }} />
            {getFileIcon(node.name)}
          </>
        )}
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {node.name}
        </span>

        {/* Hover action icons */}
        <div className="tree-actions" style={{ display: 'none' }}>
          {node.isDirectory && (
            <button
              className="icon-btn"
              title="New File Inside"
              onClick={(e) => {
                e.stopPropagation();
                onCreateItem(node.path, false);
              }}
            >
              <Plus size={12} />
            </button>
          )}
          <button
            className="icon-btn"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation();
              onDeleteItem(node.path);
            }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {node.isDirectory && isOpen && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              activeFilePath={activeFilePath}
              onSelectFile={onSelectFile}
              onCreateItem={onCreateItem}
              onDeleteItem={onDeleteItem}
              onRenameItem={onRenameItem}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const FileTree: React.FC<Props> = ({
  tree,
  activeFilePath,
  onSelectFile,
  onCreateItem,
  onDeleteItem,
  onRenameItem,
  onRefresh,
  currentRoot,
  width,
}) => {
  const [filterText, setFilterText] = useState('');

  return (
    <div
      className="ide-sidebar"
      style={width !== undefined ? { width: `${width}px` } : undefined}
    >
      <div className="sidebar-header">
        <span>EXPLORER</span>
        <div className="sidebar-actions">
          <button
            className="icon-btn"
            title="New File"
            onClick={() => onCreateItem(currentRoot, false)}
          >
            <Plus size={14} />
          </button>
          <button
            className="icon-btn"
            title="New Folder"
            onClick={() => onCreateItem(currentRoot, true)}
          >
            <Folder size={14} />
          </button>
          <button className="icon-btn" title="Refresh Tree" onClick={onRefresh}>
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {/* Quick search filter */}
      <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border-color)' }}>
        <input
          type="text"
          placeholder="Filter files..."
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          style={{
            width: '100%',
            background: 'rgba(255, 255, 255, 0.04)',
            border: '1px solid var(--border-color)',
            borderRadius: 4,
            padding: '4px 8px',
            color: 'var(--text-main)',
            fontSize: 11,
            outline: 'none',
          }}
        />
      </div>

      <div className="file-tree-view">
        {tree.length === 0 ? (
          <div style={{ padding: 16, fontSize: 12, color: 'var(--text-dim)' }}>
            Workspace is empty.
          </div>
        ) : (
          tree.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              activeFilePath={activeFilePath}
              onSelectFile={onSelectFile}
              onCreateItem={onCreateItem}
              onDeleteItem={onDeleteItem}
              onRenameItem={onRenameItem}
            />
          ))
        )}
      </div>
    </div>
  );
};
