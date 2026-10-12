import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import os from 'os';
import pty from 'node-pty';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3001;
const OLLAMA_BASE_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

// ==========================================
// 1. SYSTEM HARDWARE & RAM COST CALCULATOR
// ==========================================
function getSystemMemory() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  
  // Try reading /proc/meminfo for more precise Available memory on Linux
  let availableBytes = freeBytes;
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const match = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
    if (match) {
      availableBytes = parseInt(match[1], 10) * 1024;
    }
  } catch (e) {
    // fallback to os.freemem()
  }

  const usedBytes = totalBytes - availableBytes;

  return {
    totalBytes,
    usedBytes,
    availableBytes,
    totalGB: (totalBytes / 1024 / 1024 / 1024).toFixed(1),
    usedGB: (usedBytes / 1024 / 1024 / 1024).toFixed(1),
    availableGB: (availableBytes / 1024 / 1024 / 1024).toFixed(1),
    usedPercent: Math.round((usedBytes / totalBytes) * 100),
  };
}

// Calculate estimated RAM cost for a model
function estimateModelRam(modelSizeBytes, paramSizeStr = '') {
  const sizeGB = modelSizeBytes / (1024 * 1024 * 1024);
  
  // KV Cache estimation (assuming 4k-8k context)
  // For ~1.5B: ~0.4 GB
  // For ~7B: ~0.9 GB
  // For ~8B+: ~1.2 GB
  let kvCacheGB = 0.5;
  if (sizeGB > 4.5) kvCacheGB = 1.2;
  else if (sizeGB > 2.5) kvCacheGB = 0.9;
  else kvCacheGB = 0.4;

  const runtimeBufferGB = 0.5;
  const estimatedTotalGB = parseFloat((sizeGB + kvCacheGB + runtimeBufferGB).toFixed(2));

  return {
    weightsGB: parseFloat(sizeGB.toFixed(2)),
    kvCacheGB,
    runtimeBufferGB,
    totalEstimatedGB: estimatedTotalGB,
  };
}

// ==========================================
// 2. MODEL DISCOVERY ENGINE
// ==========================================
// Discovers models from Ollama API, Ollama disk manifests, and HuggingFace cache
async function discoverInstalledModels() {
  const models = new Map();
  const mem = getSystemMemory();
  const availGB = parseFloat(mem.availableGB);

  // A. Check running Ollama API
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.models)) {
        for (const m of data.models) {
          const ram = estimateModelRam(m.size, m.details?.parameter_size);
          let safety = 'SAFE';
          if (ram.totalEstimatedGB > availGB) {
            safety = 'SWAP_HEAVY';
          } else if (ram.totalEstimatedGB > availGB * 0.75) {
            safety = 'TIGHT';
          }

          models.set(m.name, {
            name: m.name,
            source: 'ollama_running',
            sizeBytes: m.size,
            sizeGB: (m.size / (1024 * 1024 * 1024)).toFixed(2),
            parameterSize: m.details?.parameter_size || 'Unknown',
            quantization: m.details?.quantization_level || 'Q4',
            format: m.details?.format || 'gguf',
            family: m.details?.family || 'unknown',
            capabilities: m.capabilities || ['completion'],
            ramEstimate: ram,
            safetyBadge: safety,
            isRunning: true,
          });
        }
      }
    }
  } catch (err) {
    // Ollama daemon not running or not responding
  }

  // B. Check Ollama manifests on disk (detects installed models even when Ollama is NOT running!)
  const ollamaManifestDir = path.join(os.homedir(), '.ollama', 'models', 'manifests', 'registry.ollama.ai', 'library');
  if (fs.existsSync(ollamaManifestDir)) {
    try {
      const modelDirs = fs.readdirSync(ollamaManifestDir);
      for (const modelName of modelDirs) {
        const fullModelDir = path.join(ollamaManifestDir, modelName);
        if (fs.statSync(fullModelDir).isDirectory()) {
          const tags = fs.readdirSync(fullModelDir);
          for (const tag of tags) {
            const fullName = `${modelName}:${tag}`;
            if (!models.has(fullName)) {
              try {
                const manifestContent = JSON.parse(fs.readFileSync(path.join(fullModelDir, tag), 'utf8'));
                const sizeBytes = manifestContent.layers?.reduce((acc, l) => acc + (l.size || 0), 0) || 0;
                const ram = estimateModelRam(sizeBytes, tag);
                let safety = 'SAFE';
                if (ram.totalEstimatedGB > availGB) {
                  safety = 'SWAP_HEAVY';
                } else if (ram.totalEstimatedGB > availGB * 0.75) {
                  safety = 'TIGHT';
                }

                models.set(fullName, {
                  name: fullName,
                  source: 'ollama_disk_manifest',
                  sizeBytes,
                  sizeGB: (sizeBytes / (1024 * 1024 * 1024)).toFixed(2),
                  parameterSize: tag,
                  quantization: 'Quantized',
                  format: 'gguf',
                  family: modelName,
                  capabilities: ['completion'],
                  ramEstimate: ram,
                  safetyBadge: safety,
                  isRunning: false,
                });
              } catch (e) {}
            }
          }
        }
      }
    } catch (e) {}
  }

  // C. Check HuggingFace Cache
  const hfCacheDir = path.join(os.homedir(), '.cache', 'huggingface', 'hub');
  if (fs.existsSync(hfCacheDir)) {
    try {
      const hfEntries = fs.readdirSync(hfCacheDir);
      for (const entry of hfEntries) {
        if (entry.startsWith('models--')) {
          const cleanName = entry.replace('models--', '').replace('--', '/');
          if (!models.has(cleanName)) {
            const fullPath = path.join(hfCacheDir, entry);
            let totalBytes = 0;
            // approximate size
            try {
              const snapshots = path.join(fullPath, 'snapshots');
              if (fs.existsSync(snapshots)) {
                const snapDirs = fs.readdirSync(snapshots);
                if (snapDirs.length > 0) {
                  const targetSnap = path.join(snapshots, snapDirs[0]);
                  const files = fs.readdirSync(targetSnap);
                  for (const f of files) {
                    const st = fs.statSync(path.join(targetSnap, f));
                    totalBytes += st.size;
                  }
                }
              }
            } catch (e) {}

            if (totalBytes > 0) {
              const ram = estimateModelRam(totalBytes);
              models.set(cleanName, {
                name: cleanName,
                source: 'huggingface_cache',
                sizeBytes: totalBytes,
                sizeGB: (totalBytes / (1024 * 1024 * 1024)).toFixed(2),
                parameterSize: 'HF Cache',
                quantization: 'HF Weights',
                format: 'safetensors/gguf',
                family: 'huggingface',
                capabilities: ['completion'],
                ramEstimate: ram,
                safetyBadge: ram.totalEstimatedGB > availGB ? 'SWAP_HEAVY' : 'SAFE',
                isRunning: false,
              });
            }
          }
        }
      }
    } catch (e) {}
  }

  return Array.from(models.values());
}

// System Memory API
app.get('/api/system/memory', (req, res) => {
  res.json(getSystemMemory());
});

// Installed Models API
app.get('/api/models', async (req, res) => {
  try {
    const list = await discoverInstalledModels();
    res.json({
      models: list,
      systemMemory: getSystemMemory(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. WORKSPACE & FILE SYSTEM MANIPULATION
// ==========================================
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'target', '.cache', '.gemini', '.ide']);

function buildFileTree(dirPath, currentDepth = 0, maxDepth = 4) {
  if (currentDepth > maxDepth || !fs.existsSync(dirPath)) return [];

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const result = [];

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      result.push({
        name: entry.name,
        path: fullPath,
        isDirectory: true,
        children: buildFileTree(fullPath, currentDepth + 1, maxDepth),
      });
    } else {
      let size = 0;
      try {
        size = fs.statSync(fullPath).size;
      } catch (e) {}
      result.push({
        name: entry.name,
        path: fullPath,
        isDirectory: false,
        size,
      });
    }
  }

  // Sort folders first, then files
  return result.sort((a, b) => {
    if (a.isDirectory === b.isDirectory) return a.name.localeCompare(b.name);
    return a.isDirectory ? -1 : 1;
  });
}

// Browse filesystem directories for the workspace picker modal
app.get('/api/filesystem/directories', (req, res) => {
  const homeDir = os.homedir();
  let targetPath = req.query.path ? String(req.query.path) : homeDir;

  try {
    if (!fs.existsSync(targetPath)) {
      targetPath = homeDir;
    }
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      targetPath = path.dirname(targetPath);
    }

    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    const directories = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.ide') continue;
      if (['node_modules', 'dist', 'target', '.cache', '.npm', '.local'].includes(entry.name)) continue;

      if (entry.isDirectory()) {
        const fullDir = path.join(targetPath, entry.name);
        const hasIde = fs.existsSync(path.join(fullDir, '.ide', 'session.json'));
        let subCount = 0;
        try {
          subCount = fs.readdirSync(fullDir).length;
        } catch (e) {}

        directories.push({
          name: entry.name,
          path: fullDir,
          hasIdeSession: hasIde,
          subItemCount: subCount,
        });
      }
    }

    directories.sort((a, b) => {
      if (a.hasIdeSession && !b.hasIdeSession) return -1;
      if (!a.hasIdeSession && b.hasIdeSession) return 1;
      return a.name.localeCompare(b.name);
    });

    const parentPath = path.dirname(targetPath) !== targetPath ? path.dirname(targetPath) : null;

    res.json({
      success: true,
      currentPath: targetPath,
      parentPath,
      homePath: homeDir,
      directories,
      hasIdeSession: fs.existsSync(path.join(targetPath, '.ide', 'session.json')),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new folder via workspace picker
app.post('/api/filesystem/create-directory', (req, res) => {
  const { parentPath, folderName } = req.body;
  if (!parentPath || !folderName) {
    return res.status(400).json({ error: 'parentPath and folderName are required' });
  }

  const cleanName = folderName.trim().replace(/[\\/:*?"<>|]/g, '');
  if (!cleanName) {
    return res.status(400).json({ error: 'Invalid directory name' });
  }

  const newPath = path.join(parentPath, cleanName);
  try {
    if (!fs.existsSync(newPath)) {
      fs.mkdirSync(newPath, { recursive: true });
    }
    res.json({ success: true, path: newPath, name: cleanName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get workspace file tree
app.get('/api/workspace/tree', (req, res) => {
  const targetPath = req.query.path ? String(req.query.path) : process.cwd();
  try {
    if (!fs.existsSync(targetPath)) {
      return res.status(404).json({ error: 'Directory does not exist' });
    }
    const tree = buildFileTree(targetPath);
    res.json({ rootPath: targetPath, tree });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read file content
app.get('/api/workspace/file', (req, res) => {
  const filePath = req.query.path ? String(req.query.path) : '';
  try {
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is a directory' });
    }
    // Limit to 5MB for text safety
    if (stat.size > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large to open in text editor' });
    }
    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ path: filePath, content, size: stat.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Write / save file content
app.post('/api/workspace/file', (req, res) => {
  const { path: filePath, content } = req.body;
  if (!filePath || content === undefined) {
    return res.status(400).json({ error: 'path and content are required' });
  }
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, 'utf8');
    res.json({ success: true, path: filePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new file or folder
app.post('/api/workspace/create', (req, res) => {
  const { path: targetPath, isDirectory } = req.body;
  if (!targetPath) return res.status(400).json({ error: 'path is required' });

  try {
    if (isDirectory) {
      fs.mkdirSync(targetPath, { recursive: true });
    } else {
      const dir = path.dirname(targetPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(targetPath)) {
        fs.writeFileSync(targetPath, '', 'utf8');
      }
    }
    res.json({ success: true, path: targetPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rename file or folder
app.post('/api/workspace/rename', (req, res) => {
  const { oldPath, newPath } = req.body;
  if (!oldPath || !newPath) return res.status(400).json({ error: 'oldPath and newPath are required' });

  try {
    fs.renameSync(oldPath, newPath);
    res.json({ success: true, newPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete file or folder
app.post('/api/workspace/delete', (req, res) => {
  const { path: targetPath } = req.body;
  if (!targetPath) return res.status(400).json({ error: 'path is required' });

  try {
    if (fs.existsSync(targetPath)) {
      const stat = fs.statSync(targetPath);
      if (stat.isDirectory()) {
        fs.rmSync(targetPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(targetPath);
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Load workspace session (.ide/session.json)
app.get('/api/workspace/session', (req, res) => {
  const targetPath = req.query.path ? String(req.query.path) : process.cwd();
  try {
    const session = loadIdeSession(targetPath);
    res.json({ success: true, session });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save workspace session (.ide/session.json)
app.post('/api/workspace/session', (req, res) => {
  const { workspacePath, sessionData } = req.body;
  if (!workspacePath || !sessionData) {
    return res.status(400).json({ error: 'workspacePath and sessionData are required' });
  }
  try {
    const ok = saveIdeSession(workspacePath, sessionData);
    res.json({ success: ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get workspace activity log (.ide/activity.json)
app.get('/api/workspace/activity', (req, res) => {
  const targetPath = req.query.path ? String(req.query.path) : process.cwd();
  try {
    const activity = loadIdeActivity(targetPath);
    res.json({ success: true, activity });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4. TERMINAL & COMMAND EXECUTION (PTY + EXEC)
// ==========================================
import { exec } from 'child_process';
import util from 'util';
const execPromise = util.promisify(exec);

// Execute a terminal command synchronously with stdout/stderr & error checking
app.post('/api/terminal/run', async (req, res) => {
  const { command, cwd } = req.body;
  if (!command) return res.status(400).json({ error: 'command is required' });

  const workingDir = cwd && fs.existsSync(cwd) ? cwd : process.cwd();

  try {
    const { stdout, stderr } = await execPromise(command, {
      cwd: workingDir,
      timeout: 60000,
      maxBuffer: 5 * 1024 * 1024,
    });

    res.json({
      success: true,
      exitCode: 0,
      stdout,
      stderr,
      hasError: false,
    });
  } catch (err) {
    res.json({
      success: false,
      exitCode: err.code || 1,
      stdout: err.stdout || '',
      stderr: err.stderr || err.message,
      hasError: true,
    });
  }
});

// WebSocket Terminal PTY stream for interactive bash terminal in the IDE
wss.on('connection', (ws) => {
  const shell = process.env.SHELL || '/bin/bash';
  let ptyProcess = null;

  try {
    ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
    });

    ptyProcess.onData((data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'output', data }));
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', exitCode }));
      }
    });
  } catch (e) {
    console.error('Failed to spawn PTY:', e);
  }

  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      if (parsed.type === 'input' && ptyProcess) {
        ptyProcess.write(parsed.data);
      } else if (parsed.type === 'resize' && ptyProcess) {
        ptyProcess.resize(parsed.cols || 80, parsed.rows || 24);
      } else if (parsed.type === 'set_cwd' && ptyProcess) {
        ptyProcess.write(`cd "${parsed.cwd}"\r`);
      }
    } catch (e) {
      if (ptyProcess) ptyProcess.write(msg.toString());
    }
  });

  ws.on('close', () => {
    if (ptyProcess) {
      try {
        ptyProcess.kill();
      } catch (e) {}
    }
  });
});

// ==========================================
// 5. AGENTIC EXECUTION & STREAMING CHAT
// ==========================================
const activeGenerations = new Set();

const OLLAMA_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or update a file in the workspace directory with complete source code',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path of the file to create or modify, e.g. "index.html", "script.js", "src/main.rs"',
          },
          content: {
            type: 'string',
            description: 'Complete source code content to write into the file',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_terminal_command',
      description: 'Run a shell command in the workspace directory, e.g. "npm init -y", "touch script.js", "cargo build"',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute in the workspace',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file in the workspace',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path of the file to read',
          },
        },
        required: ['path'],
      },
    },
  },
];

function writeWorkspaceFile(workspacePath, relPath, content) {
  const cleanRel = relPath.replace(/^(\.\/|\/)/, '').trim();
  const absPath = path.resolve(workspacePath, cleanRel);
  if (!absPath.startsWith(path.resolve(workspacePath))) {
    throw new Error(`Path security violation: ${relPath} escapes workspace`);
  }
  const dir = path.dirname(absPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  let originalContent = '';
  let isNewFile = true;
  if (fs.existsSync(absPath)) {
    try {
      originalContent = fs.readFileSync(absPath, 'utf8');
      isNewFile = false;
    } catch (e) {}
  }
  fs.writeFileSync(absPath, content, 'utf8');
  return {
    absPath,
    relPath: cleanRel,
    size: Buffer.byteLength(content),
    originalContent,
    isNewFile,
    content,
  };
}

function readWorkspaceFile(workspacePath, relPath) {
  const cleanRel = relPath.replace(/^(\.\/|\/)/, '').trim();
  const absPath = path.resolve(workspacePath, cleanRel);
  if (!absPath.startsWith(path.resolve(workspacePath))) {
    throw new Error(`Path security violation: ${relPath} escapes workspace`);
  }
  if (!fs.existsSync(absPath)) {
    throw new Error(`File not found: ${cleanRel}`);
  }
  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) {
    throw new Error(`Path is a directory: ${cleanRel}`);
  }
  const content = fs.readFileSync(absPath, 'utf8');
  return { absPath, relPath: cleanRel, content, size: stat.size };
}

// ==========================================
// .IDE PERSISTENCE & SESSION ENGINE
// ==========================================
function getIdeDir(workspacePath) {
  const ideDir = path.join(workspacePath, '.ide');
  if (!fs.existsSync(ideDir)) {
    fs.mkdirSync(ideDir, { recursive: true });
  }
  return ideDir;
}

function loadIdeSession(workspacePath) {
  try {
    const sessionFile = path.join(workspacePath, '.ide', 'session.json');
    if (fs.existsSync(sessionFile)) {
      return JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load .ide/session.json:', e);
  }
  return null;
}

function saveIdeSession(workspacePath, sessionData) {
  try {
    const ideDir = getIdeDir(workspacePath);
    const sessionFile = path.join(ideDir, 'session.json');
    const dataToSave = {
      version: '1.0',
      updatedAt: new Date().toISOString(),
      ...sessionData,
    };
    fs.writeFileSync(sessionFile, JSON.stringify(dataToSave, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Failed to save .ide/session.json:', e);
    return false;
  }
}

function appendIdeActivity(workspacePath, activityItem) {
  try {
    const ideDir = getIdeDir(workspacePath);
    const activityFile = path.join(ideDir, 'activity.json');
    let activityLog = [];
    if (fs.existsSync(activityFile)) {
      try {
        activityLog = JSON.parse(fs.readFileSync(activityFile, 'utf8'));
      } catch (e) {}
    }
    const item = {
      id: `act-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      timestamp: new Date().toISOString(),
      ...activityItem,
    };
    activityLog.unshift(item);
    if (activityLog.length > 200) activityLog = activityLog.slice(0, 200);
    fs.writeFileSync(activityFile, JSON.stringify(activityLog, null, 2), 'utf8');

    updateIdeContextMarkdown(workspacePath, activityLog);
    return item;
  } catch (e) {
    console.error('Failed to append to .ide/activity.json:', e);
  }
}

function loadIdeActivity(workspacePath) {
  try {
    const activityFile = path.join(workspacePath, '.ide', 'activity.json');
    if (fs.existsSync(activityFile)) {
      return JSON.parse(fs.readFileSync(activityFile, 'utf8'));
    }
  } catch (e) {}
  return [];
}

function updateIdeContextMarkdown(workspacePath, activityLog = []) {
  try {
    const ideDir = getIdeDir(workspacePath);
    const contextFile = path.join(ideDir, 'context.md');

    const entries = fs.readdirSync(workspacePath, { withFileTypes: true });
    const files = entries
      .filter((e) => !e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
    const dirs = entries
      .filter((e) => e.isDirectory() && !['node_modules', '.git', '.ide', 'dist'].includes(e.name))
      .map((e) => e.name);

    const recentActions = (activityLog || [])
      .slice(0, 15)
      .map((a) => {
        if (a.type === 'file_written') return `- Created/Modified \`${a.path}\` (${a.size} bytes)`;
        if (a.type === 'command_executed') return `- Executed \`${a.command}\` (exit code: ${a.exitCode})`;
        if (a.type === 'phase_completed') return `- Completed Phase ${a.phaseNumber}: ${a.title}`;
        if (a.type === 'plan_generated') return `- Generated Implementation Plan: ${a.title || ''}`;
        return `- ${a.type}: ${JSON.stringify(a)}`;
      })
      .join('\n');

    const content = `# Antigravity IDE Workspace Context
**Workspace Path:** \`${workspacePath}\`
**Last Updated:** ${new Date().toLocaleString()}

## Project Layout
- **Directories:** ${dirs.join(', ') || 'None'}
- **Files:** ${files.join(', ') || 'None'}

## Recent Workspace Activity Log
${recentActions || 'No actions recorded yet.'}
`;
    fs.writeFileSync(contextFile, content, 'utf8');
  } catch (e) {
    console.error('Failed to update .ide/context.md:', e);
  }
}

async function runWorkspaceCommand(workspacePath, command) {
  const workingDir = workspacePath && fs.existsSync(workspacePath) ? workspacePath : process.cwd();
  try {
    const { stdout, stderr } = await execPromise(command, {
      cwd: workingDir,
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      success: true,
      exitCode: 0,
      stdout: stdout || '',
      stderr: stderr || '',
      hasError: false,
    };
  } catch (err) {
    return {
      success: false,
      exitCode: err.code || 1,
      stdout: err.stdout || '',
      stderr: err.stderr || err.message,
      hasError: true,
    };
  }
}

function extractActionsFromText(text) {
  const fileActions = [];
  const bashActions = [];

  // 1. Explicit ```file:filename.ext
  const filePattern = /```(?:file|write|create):([^\n\r]+)[\r\n]([\s\S]*?)```/g;
  let match;
  while ((match = filePattern.exec(text)) !== null) {
    const filePath = match[1].trim();
    const content = match[2];
    fileActions.push({ path: filePath, content });
  }

  // 2. Explicit ```bash:run or ```sh:run
  const bashPattern = /```(?:bash|sh|cmd):run[\r\n]([\s\S]*?)```/g;
  while ((match = bashPattern.exec(text)) !== null) {
    const command = match[1].trim();
    if (command) bashActions.push({ command });
  }

  // 3. Fallback Heuristic: standard code block preceded by filename (e.g. "create a new JavaScript file ( script.js ) to handle... ```javascript")
  const heuristicPattern = /(?:create|file|in|named|modify|write|add)?\s*[`(]?([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]{1,8})[`)\]:]?\s*(?:to handle[^\n]*|:\s*)?\n+```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/gi;
  while ((match = heuristicPattern.exec(text)) !== null) {
    const candidatePath = match[1].trim();
    const code = match[2];
    if (!candidatePath.includes(' ') && !fileActions.some((f) => f.path === candidatePath) && code.trim().length > 0) {
      const ext = path.extname(candidatePath).toLowerCase();
      if (['.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.json', '.py', '.php', '.rs', '.vue', '.sh', '.md', '.sql'].includes(ext)) {
        fileActions.push({ path: candidatePath, content: code });
      }
    }
  }

  // 4. Fallback Heuristic: JSON tool call emitted in text by smaller models
  const jsonToolPattern = /\{\s*"name"\s*:\s*"write_file"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?"path"\s*:\s*"([^"]+)"[\s\S]*?"content"\s*:\s*"([\s\S]*?)"\s*\}\s*\}/g;
  while ((match = jsonToolPattern.exec(text)) !== null) {
    const p = match[1];
    let c = match[2];
    try {
      c = JSON.parse(`"${c}"`);
    } catch (e) {}
    if (!fileActions.some((f) => f.path === p)) {
      fileActions.push({ path: p, content: c });
    }
  }

  // 5. Code block with first line comment containing filename: e.g. // index.js or /* style.css */ or <!-- index.html -->
  const blockWithCommentPattern = /```(?:[a-zA-Z0-9_-]+)?[\r\n]+(?:\/\/|#|<!--|\/\*)\s*([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]{1,8})(?:\s*-->|\s*\*\/)?[\r\n]([\s\S]*?)```/g;
  while ((match = blockWithCommentPattern.exec(text)) !== null) {
    const candidatePath = match[1].trim();
    const code = match[2];
    if (!candidatePath.includes(' ') && !fileActions.some((f) => f.path === candidatePath) && code.trim().length > 0) {
      const ext = path.extname(candidatePath).toLowerCase();
      if (['.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.json', '.py', '.php', '.rs', '.vue', '.sh', '.md', '.sql'].includes(ext)) {
        fileActions.push({ path: candidatePath, content: code });
      }
    }
  }

  // 6. Header or bold filename immediately before code block: e.g. ### `index.html`\n```html or **styles.css**\n```css
  const headerOrBoldPattern = /(?:###?\s+|[*_]{1,2}|`)([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]{1,8})(?:[*_]{1,2}|`|:)?[\r\n]+```(?:[a-zA-Z0-9_-]+)?[\r\n]([\s\S]*?)```/g;
  while ((match = headerOrBoldPattern.exec(text)) !== null) {
    const candidatePath = match[1].trim();
    const code = match[2];
    if (!candidatePath.includes(' ') && !fileActions.some((f) => f.path === candidatePath) && code.trim().length > 0) {
      const ext = path.extname(candidatePath).toLowerCase();
      if (['.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.json', '.py', '.php', '.rs', '.vue', '.sh', '.md', '.sql'].includes(ext)) {
        fileActions.push({ path: candidatePath, content: code });
      }
    }
  }

  return { fileActions, bashActions };
}

function parsePhasesFromPlan(planMarkdown) {
  const phases = [];
  const phaseRegex = /#{1,4}\s+Phase\s+(\d+)[:\s]+([^\n]+)([\s\S]*?)(?=(?:#{1,4}\s+Phase\s+\d+|$))/gi;
  let match;
  while ((match = phaseRegex.exec(planMarkdown)) !== null) {
    const num = parseInt(match[1], 10);
    const title = match[2].trim();
    const body = match[3] || '';

    const fileMatches = body.match(/Target Files:?\s*([^\n]+)/i);
    const targetFiles = fileMatches
      ? fileMatches[1]
          .split(/[,;]/)
          .map((s) => s.replace(/[`*]/g, '').trim())
          .filter(Boolean)
      : [];

    const cmdMatches = body.match(/Commands:?\s*([^\n]+)/i);
    const commands = cmdMatches
      ? cmdMatches[1]
          .split(/[,;]/)
          .map((s) => s.replace(/[`*]/g, '').trim())
          .filter(Boolean)
      : [];

    phases.push({
      id: `phase-${num}-${Date.now()}`,
      number: num,
      title,
      description: body.trim(),
      targetFiles,
      commands,
      status: 'pending',
    });
  }

  // Fallback if model did not use "### Phase N:" syntax
  if (phases.length === 0) {
    phases.push(
      {
        id: `phase-1-${Date.now()}`,
        number: 1,
        title: 'Project Scaffolding & Setup',
        description: 'Initialize configuration, directory layout, and boilerplate files',
        targetFiles: [],
        commands: [],
        status: 'pending',
      },
      {
        id: `phase-2-${Date.now()}`,
        number: 2,
        title: 'Core Implementation',
        description: 'Implement core functionality, files, and styles',
        targetFiles: [],
        commands: [],
        status: 'pending',
      },
      {
        id: `phase-3-${Date.now()}`,
        number: 3,
        title: 'Verification & Polish',
        description: 'Test, verify execution, and fix any errors',
        targetFiles: [],
        commands: [],
        status: 'pending',
      }
    );
  }

  return phases;
}

app.post('/api/agent/stop', (req, res) => {
  let count = 0;
  for (const c of activeGenerations) {
    try {
      c.abort();
      count++;
    } catch (e) {}
  }
  activeGenerations.clear();
  res.json({ success: true, stopped: count });
});

// Endpoint: Generate Implementation Plan and write IMPLEMENTATION_PLAN.md to disk
app.post('/api/agent/plan', async (req, res) => {
  const { model, prompt, workspacePath } = req.body;
  if (!model || !prompt) {
    return res.status(400).json({ error: 'model and prompt are required' });
  }

  const targetWorkspace = workspacePath || process.cwd();
  const tree = buildFileTree(targetWorkspace, 0, 2);
  const fileListSnippet = tree.map((t) => (t.isDirectory ? `📁 ${t.name}/` : `📄 ${t.name}`)).join('\n');

  const architectPrompt = `You are the Lead Software Architect of Antigravity IDE.
Target workspace directory: ${targetWorkspace}
Existing files in workspace:
${fileListSnippet || '(Empty workspace)'}

USER REQUEST:
"${prompt}"

Break this task down into 2 to 4 clear, logical, sequential PHASES.
Your response MUST be a detailed Markdown Implementation Plan following this exact format:

# Implementation Plan: ${prompt.slice(0, 50)}

## Overview
Brief architectural overview and technology stack choice.

## Phased Execution Roadmap

### Phase 1: [Phase Title]
- **Goal:** [What this phase accomplishes]
- **Target Files:** [Comma-separated file names to create, e.g. index.html, package.json]
- **Commands:** [Comma-separated commands, if needed, e.g. npm init -y]
- **Checklist:**
- [ ] [Specific actionable step]
- [ ] [Specific actionable step]

### Phase 2: [Phase Title]
- **Goal:** [What this phase accomplishes]
- **Target Files:** [Comma-separated file names to create]
- **Commands:** [Comma-separated commands]
- **Checklist:**
- [ ] [Specific actionable step]

(Repeat for any remaining phases)`;

  try {
    const ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: architectPrompt }],
        stream: false,
        options: {
          temperature: 0.2,
          num_predict: 2048,
        },
      }),
    });

    if (!ollamaRes.ok) {
      const err = await ollamaRes.text();
      return res.status(500).json({ error: `Ollama error: ${err}` });
    }

    const data = await ollamaRes.json();
    let planMarkdown = data.message?.content || '';
    planMarkdown = planMarkdown.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    // Write IMPLEMENTATION_PLAN.md directly to the workspace folder!
    const planFileName = 'IMPLEMENTATION_PLAN.md';
    const planFileAbs = path.join(targetWorkspace, planFileName);
    fs.writeFileSync(planFileAbs, planMarkdown, 'utf8');

    const phases = parsePhasesFromPlan(planMarkdown);

    // Extract checklist tasks
    const checklistMatches = [...planMarkdown.matchAll(/- \[[ xX]\]\s*([^\n]+)/g)];
    const tasks = checklistMatches.map((m, idx) => ({
      id: `task-${idx}-${Date.now()}`,
      title: m[1].trim(),
      completed: false,
    }));

    appendIdeActivity(targetWorkspace, {
      type: 'plan_generated',
      title: prompt.slice(0, 80),
      planFile: planFileName,
      phasesCount: phases.length,
      tasksCount: tasks.length,
    });

    res.json({
      success: true,
      planMarkdown,
      phases,
      tasks,
      planFilePath: planFileAbs,
      planFileRelative: planFileName,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint: Verify workspace files for syntax, existence, and basic sanity
app.post('/api/agent/verify', async (req, res) => {
  const { workspacePath, files = [] } = req.body;
  const targetWorkspace = workspacePath || process.cwd();
  const results = [];

  for (const f of files) {
    const cleanRel = f.replace(/^(\.\/|\/)/, '').trim();
    const absPath = path.resolve(targetWorkspace, cleanRel);
    if (!fs.existsSync(absPath)) {
      results.push({ path: cleanRel, exists: false, error: 'File does not exist' });
      continue;
    }
    const stat = fs.statSync(absPath);
    if (stat.size === 0) {
      results.push({ path: cleanRel, exists: true, size: 0, error: 'File is empty (0 bytes)' });
      continue;
    }

    const ext = path.extname(cleanRel).toLowerCase();
    let syntaxError = null;

    if (ext === '.json') {
      try {
        JSON.parse(fs.readFileSync(absPath, 'utf8'));
      } catch (err) {
        syntaxError = `Invalid JSON syntax: ${err.message}`;
      }
    } else if (ext === '.js' || ext === '.mjs') {
      try {
        await execPromise(`node --check "${absPath}"`, { cwd: targetWorkspace, timeout: 5000 });
      } catch (err) {
        syntaxError = `JavaScript syntax error: ${err.stderr || err.message}`;
      }
    } else if (ext === '.py') {
      try {
        await execPromise(`python3 -m py_compile "${absPath}"`, { cwd: targetWorkspace, timeout: 5000 });
      } catch (err) {
        syntaxError = `Python syntax error: ${err.stderr || err.message}`;
      }
    }

    results.push({
      path: cleanRel,
      exists: true,
      size: stat.size,
      hasError: !!syntaxError,
      error: syntaxError,
    });
  }

  const hasAnyError = results.some((r) => r.hasError || !r.exists);
  res.json({ success: true, verified: !hasAnyError, results });
});

// Endpoint: Stream Agent Response & Execute Tools / File Writes in Real-Time
app.post('/api/agent/stream', async (req, res) => {
    const {
      model,
      prompt,
      workspacePath,
      thinkingEnabled,
      mode,
      activeFile,
      openTabs = [],
      autoApplyFiles = true,
      autoExecuteCommands = true,
      conversationHistory = [],
    } = req.body;

    if (!model || !prompt) {
      return res.status(400).json({ error: 'model and prompt are required' });
    }

  // Setup SSE streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (event, data) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) {}
  };

  const controller = new AbortController();
  activeGenerations.add(controller);

  // Only abort if client socket terminates before stream completion
  res.on('close', () => {
    if (!res.writableEnded) {
      controller.abort();
    }
    activeGenerations.delete(controller);
  });

  try {
    const targetWorkspace = workspacePath || process.cwd();
    const tree = buildFileTree(targetWorkspace, 0, 2);
    const fileListSnippet = tree.map((t) => (t.isDirectory ? `📁 ${t.name}/` : `📄 ${t.name}`)).join('\n');

    let manifestInfo = '';
    const pkgPath = path.join(targetWorkspace, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        manifestInfo += `\npackage.json dependencies: ${JSON.stringify({ ...pkg.dependencies, ...pkg.devDependencies })}`;
      } catch (e) {}
    }

    // 1. Context from .ide/context.md
    let ideContextSnippet = '';
    const ideContextPath = path.join(targetWorkspace, '.ide', 'context.md');
    if (fs.existsSync(ideContextPath)) {
      try {
        const ctxText = fs.readFileSync(ideContextPath, 'utf8');
        ideContextSnippet = `\n--- RECENT WORKSPACE ACTIVITY (.ide) ---\n${ctxText.slice(0, 1500)}\n`;
      } catch (e) {}
    }

    // 2. Direct File System Inspection: Top-level workspace code files
    let existingFilesSnippet = '';
    try {
      const topEntries = fs.readdirSync(targetWorkspace, { withFileTypes: true });
      const codeFiles = topEntries
        .filter((e) => !e.isDirectory() && !e.name.startsWith('.') && e.name !== 'package-lock.json')
        .slice(0, 10);

      let collected = '';
      for (const cf of codeFiles) {
        const fPath = path.join(targetWorkspace, cf.name);
        const stat = fs.statSync(fPath);
        if (stat.size <= 20000) {
          const content = fs.readFileSync(fPath, 'utf8');
          collected += `\n--- File: ${cf.name} (${stat.size} bytes) ---\n${content}\n`;
        }
      }
      if (collected) {
        existingFilesSnippet = `\nCURRENT SOURCE FILES ON DISK IN WORKSPACE:\n${collected}`;
      }
    } catch (e) {}

    // 3. Active Monaco Editor File (if provided)
    let activeFileSnippet = '';
    if (activeFile && activeFile.path && activeFile.content) {
      activeFileSnippet = `\nCURRENTLY ACTIVE OPEN FILE IN MONACO EDITOR:
Path: ${activeFile.path}
Content:
\`\`\`
${activeFile.content.slice(0, 10000)}
\`\`\`\n`;
    }

    let systemInstruction = `You are the Autonomous Software Engineer of the Antigravity IDE.
You are running directly on Linux Ubuntu with full access to the project workspace at:
${targetWorkspace}

Workspace Files:
${fileListSnippet || '(Empty workspace)'}
${manifestInfo}
${ideContextSnippet}
${existingFilesSnippet}
${activeFileSnippet}

CRITICAL OPERATIONAL RULES:
1. NEVER instruct the user to run commands or build files manually.
2. Provide real, complete code without placeholders or omissions.
3. You have full access to inspect, modify, and build workspace files.
4. When writing code, use explicit blocks:
\`\`\`file:relative/path/to/file.ext
[complete code here]
\`\`\`
and terminal commands using:
\`\`\`bash:run
command to execute
\`\`\`
The Antigravity backend will automatically create the files on disk and execute the commands.`;

    if (thinkingEnabled) {
      systemInstruction += `\nInclude deep reasoning steps inside <think>...</think> tags before writing your answer.`;
    }

    const messages = [
      { role: 'system', content: systemInstruction },
      ...conversationHistory,
      { role: 'user', content: prompt },
    ];

    sendEvent('status', { status: 'Connecting to local LLM...' });

    // Call Ollama streaming API with Tools (for supported models) & AbortSignal
    const ollamaRequestBody = {
      model,
      messages,
      stream: true,
      options: {
        temperature: 0.2,
        num_predict: 4096,
        stop: ['<|endoftext|>', '<|im_end|>', '\n\nUser:', '\n\nHuman:'],
      },
    };

    // Only attach native tools for models that support it (e.g., granite, 7B+ qwen)
    // Deepseek and <3B models work best with direct markdown extraction to prevent schema confusion
    const modelLower = model.toLowerCase();
    const supportsNativeTools =
      (modelLower.includes('granite') || modelLower.includes('7b') || modelLower.includes('8b') || modelLower.includes('14b')) &&
      !modelLower.includes('deepseek');

    if (supportsNativeTools) {
      ollamaRequestBody.tools = OLLAMA_TOOLS;
    }

    const ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(ollamaRequestBody),
    });

    if (!ollamaRes.ok) {
      const errText = await ollamaRes.text();
      sendEvent('error', { error: `Ollama error: ${errText}` });
      res.end();
      return;
    }

    const reader = ollamaRes.body.getReader();
    const decoder = new TextDecoder();
    let accumulatedContent = '';
    let accumulatedThinking = '';
    let inThinkTag = false;
    const collectedToolCalls = [];

    while (true) {
      if (controller.signal.aborted) {
        sendEvent('status', { status: 'Stopped' });
        break;
      }

      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter((l) => l.trim().length > 0);

      for (const line of lines) {
        if (controller.signal.aborted) break;
        try {
          const parsed = JSON.parse(line);
          const delta = parsed.message?.content || '';

          // Capture Ollama native tool calls
          if (parsed.message?.tool_calls && Array.isArray(parsed.message.tool_calls)) {
            for (const tc of parsed.message.tool_calls) {
              collectedToolCalls.push(tc);
              sendEvent('tool_call', tc);
            }
          }

          if (delta) {
            accumulatedContent += delta;

            if (delta.includes('<think>')) inThinkTag = true;
            if (inThinkTag) accumulatedThinking += delta;
            if (delta.includes('</think>')) inThinkTag = false;

            sendEvent('chunk', {
              chunk: delta,
              isThinking: inThinkTag,
            });
          }

          if (parsed.done) {
            sendEvent('stream_complete', {
              totalContent: accumulatedContent,
              totalDuration: parsed.total_duration,
              evalCount: parsed.eval_count,
            });
          }
        } catch (e) {}
      }
    }

    // ========================================================
    // AUTO-EXECUTE ACTIONS & WRITE FILES TO DISK
    // ========================================================
    const writtenFiles = [];
    const executedCommands = [];

    // 1. Process native Ollama tool calls
    for (const tc of collectedToolCalls) {
      const fnName = tc.function?.name;
      const args = tc.function?.arguments || {};
      if (fnName === 'write_file' && args.path && args.content) {
        try {
          const resWrite = writeWorkspaceFile(targetWorkspace, args.path, args.content);
          writtenFiles.push(resWrite);
          appendIdeActivity(targetWorkspace, { type: 'file_written', path: resWrite.relPath, size: resWrite.size });
          sendEvent('file_written', {
            path: resWrite.relPath,
            fullPath: resWrite.absPath,
            size: resWrite.size,
            originalContent: resWrite.originalContent,
            isNewFile: resWrite.isNewFile,
            content: resWrite.content,
            source: 'native_tool_call',
          });
        } catch (err) {
          sendEvent('file_error', { path: args.path, error: err.message });
        }
      } else if (fnName === 'run_terminal_command' && args.command && autoExecuteCommands) {
        sendEvent('command_started', { command: args.command });
        const resCmd = await runWorkspaceCommand(targetWorkspace, args.command);
        executedCommands.push({ command: args.command, ...resCmd });
        appendIdeActivity(targetWorkspace, {
          type: 'command_executed',
          command: args.command,
          exitCode: resCmd.exitCode,
          success: resCmd.success,
        });
        sendEvent('command_executed', { command: args.command, ...resCmd });
      } else if (fnName === 'read_file' && args.path) {
        try {
          const resRead = readWorkspaceFile(targetWorkspace, args.path);
          sendEvent('file_read', { path: resRead.relPath, content: resRead.content, size: resRead.size });
          appendIdeActivity(targetWorkspace, { type: 'file_read', path: resRead.relPath });
        } catch (err) {
          sendEvent('file_error', { path: args.path, error: err.message });
        }
      }
    }

    // 2. Process markdown / heuristic action blocks from text (Fallback & Multi-format)
    if (autoApplyFiles) {
      const { fileActions, bashActions } = extractActionsFromText(accumulatedContent);

      for (const fa of fileActions) {
        if (!writtenFiles.some((w) => w.relPath === fa.path.replace(/^(\.\/|\/)/, ''))) {
          try {
            const resWrite = writeWorkspaceFile(targetWorkspace, fa.path, fa.content);
            writtenFiles.push(resWrite);
            appendIdeActivity(targetWorkspace, { type: 'file_written', path: resWrite.relPath, size: resWrite.size });
            sendEvent('file_written', {
              path: resWrite.relPath,
              fullPath: resWrite.absPath,
              size: resWrite.size,
              originalContent: resWrite.originalContent,
              isNewFile: resWrite.isNewFile,
              content: resWrite.content,
              source: 'extracted_block',
            });
          } catch (err) {
            sendEvent('file_error', { path: fa.path, error: err.message });
          }
        }
      }

      if (autoExecuteCommands) {
        for (const ba of bashActions) {
          if (!executedCommands.some((c) => c.command === ba.command)) {
            sendEvent('command_started', { command: ba.command });
            const resCmd = await runWorkspaceCommand(targetWorkspace, ba.command);
            executedCommands.push({ command: ba.command, ...resCmd });
            appendIdeActivity(targetWorkspace, {
              type: 'command_executed',
              command: ba.command,
              exitCode: resCmd.exitCode,
              success: resCmd.success,
            });
            sendEvent('command_executed', { command: ba.command, ...resCmd });
          }
        }
      }
    }

    // Send final done event with complete summary
    sendEvent('done', {
      totalContent: accumulatedContent,
      writtenFiles,
      executedCommands,
    });

    res.end();
  } catch (err) {
    if (err.name === 'AbortError') {
      sendEvent('status', { status: 'Stopped' });
    } else {
      sendEvent('error', { error: err.message });
    }
    res.end();
  } finally {
    activeGenerations.delete(controller);
  }
});

server.listen(PORT, () => {
  console.log(`[Antigravity IDE Backend] Listening on http://localhost:${PORT}`);
  console.log(`[Antigravity IDE Backend] WebSocket Terminal ready on ws://localhost:${PORT}`);
});
