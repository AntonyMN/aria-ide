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
import { exec, spawn } from 'child_process';
import util from 'util';
const execPromise = util.promisify(exec);

// Track active terminal WebSocket clients to broadcast directory updates
const terminalClients = new Set();
function broadcastToTerminal(data) {
  for (const client of terminalClients) {
    if (client.readyState === 1) { // 1 = WebSocket.OPEN
      try {
        client.send(JSON.stringify(data));
      } catch (e) {}
    }
  }
}

// Active workspace working directory map (remembers current subfolder per workspace)
const workspaceCwdMap = new Map();

// Helper to snapshot directory structure
function inspectDirectorySnapshot(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return { dirs: [], files: [], all: [] };
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const dirs = [];
    const files = [];
    for (const e of entries) {
      if (IGNORED_DIRS.has(e.name)) continue;
      if (e.isDirectory()) dirs.push(e.name);
      else files.push(e.name);
    }
    return { dirs, files, all: entries.map((e) => e.name) };
  } catch (e) {
    return { dirs: [], files: [], all: [] };
  }
}

// Helper: Run a terminal command with live streaming stdout/stderr chunks
function executeCommandLiveStream({ command, cwd, onStdout, onStderr, signal }) {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/bash';
    const child = spawn(command, {
      shell: true,
      cwd,
      env: { ...process.env, FORCE_COLOR: '1' },
    });

    let stdout = '';
    let stderr = '';

    if (signal) {
      signal.addEventListener('abort', () => {
        try {
          child.kill('SIGINT');
        } catch (e) {}
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch (e) {}
        }, 1200);
      });
    }

    child.stdout.on('data', (data) => {
      const str = data.toString();
      stdout += str;
      onStdout?.(str);
    });

    child.stderr.on('data', (data) => {
      const str = data.toString();
      stderr += str;
      onStderr?.(str);
    });

    child.on('error', (err) => {
      resolve({
        success: false,
        exitCode: 1,
        stdout,
        stderr: stderr + '\n' + err.message,
        hasError: true,
      });
    });

    child.on('close', (exitCode) => {
      resolve({
        success: exitCode === 0,
        exitCode: exitCode ?? 0,
        stdout,
        stderr,
        hasError: exitCode !== 0,
      });
    });
  });
}

// Helper: Audit executed command and resulting structure changes using LLM & heuristics
async function auditCommandAndStructure({
  command,
  exitCode,
  stdout = '',
  stderr = '',
  currentCwd,
  workspacePath,
  createdDirs = [],
  createdFiles = [],
  model = 'granite4.2:8b',
  goalContext = '',
}) {
  const targetWorkspace = workspacePath || process.cwd();
  const currentDir = currentCwd || targetWorkspace;

  // 1. Inspect newly created directories in detail (e.g. files inside newly created 'blog')
  let subDirDetails = '';
  for (const dirName of createdDirs.slice(0, 3)) {
    const subPath = path.join(currentDir, dirName);
    if (fs.existsSync(subPath) && fs.statSync(subPath).isDirectory()) {
      try {
        const subEntries = fs.readdirSync(subPath).slice(0, 15);
        subDirDetails += `\nContents of newly created folder '${dirName}':\n[${subEntries.join(', ')}]\n`;
      } catch (e) {}
    }
  }

  // 2. Fallback Heuristics: guaranteed detection of project creation & cd commands
  let fallbackSuggestedCwd = null;
  let fallbackSummary =
    exitCode === 0
      ? `Command "${command}" executed successfully.`
      : `Command "${command}" exited with code ${exitCode}.`;
  let fallbackWayForward = '';
  let fallbackNextCommands = [];

  // Detect explicit cd command
  const cdMatch = command.match(/(?:^|&&|;)\s*cd\s+([^;&]+)/);
  if (cdMatch) {
    const targetDir = cdMatch[1].trim().replace(/^['"]|['"]$/g, '');
    const resolved = path.resolve(currentDir, targetDir);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      fallbackSuggestedCwd = resolved;
      fallbackSummary = `Navigated into directory "${targetDir}".`;
    }
  }

  // Detect project scaffolding commands: laravel new <name>, npx create-... <name>, cargo new <name>, mkdir <name>
  const scaffoldMatch = command.match(
    /(?:laravel\s+new|create-react-app|create-vite|create-vue|cargo\s+new|mkdir|git\s+clone[^\n]+\/)\s+([a-zA-Z0-9_\-.]+)/i
  );
  if (scaffoldMatch) {
    const candidateName = scaffoldMatch[1].trim();
    const candidatePath = path.resolve(currentDir, candidateName);
    const dirExists =
      createdDirs.includes(candidateName) ||
      (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory());
    if (dirExists) {
      fallbackSuggestedCwd = candidatePath;
      fallbackSummary = `Project folder "${candidateName}" created. Working directory shifted to "${candidateName}".`;
      fallbackWayForward = `Navigate into "${candidateName}" and verify scaffolding or install dependencies.`;

      if (fs.existsSync(path.join(candidatePath, 'composer.json')) || command.includes('laravel')) {
        fallbackNextCommands = ['composer install'];
      } else if (fs.existsSync(path.join(candidatePath, 'package.json')) || command.includes('create-')) {
        fallbackNextCommands = ['npm install'];
      }
    }
  }

  // If createdDirs has 1 new directory and exitCode === 0, suggest navigating into it
  if (!fallbackSuggestedCwd && createdDirs.length === 1 && exitCode === 0) {
    const onlyDir = path.resolve(currentDir, createdDirs[0]);
    fallbackSuggestedCwd = onlyDir;
    fallbackSummary = `Created new directory "${createdDirs[0]}". Working directory moved into "${createdDirs[0]}".`;
    fallbackWayForward = `Enter "${createdDirs[0]}" to proceed with subsequent configuration.`;
  }

  // 3. Query LLM for intelligent audit & way forward if model is available
  let llmAudit = null;
  try {
    const prompt = `You are the Autonomous Command & Workspace Structure Auditor in Aria IDE.
A shell command has executed.

COMMAND: ${command}
WORKING DIRECTORY: ${currentDir}
EXIT CODE: ${exitCode}
${stdout ? `STDOUT (recent output):\n${stdout.slice(-800)}\n` : ''}
${stderr ? `STDERR (recent output):\n${stderr.slice(-800)}\n` : ''}
NEW FOLDERS CREATED: ${createdDirs.join(', ') || 'None'}
NEW FILES CREATED: ${createdFiles.join(', ') || 'None'}
${subDirDetails}
TASK CONTEXT: ${goalContext || 'Sequential task execution'}

CRITICAL AUDIT RULES:
1. If the command created a new project directory (e.g. "laravel new blog", "npx create-vite-app blog", "cargo new myapp"), the system MUST go inside that folder. Set "suggestedCwd" to that folder name.
2. Determine if the structure is correct and what the exact WAY FORWARD is.
3. Suggest the immediate next 1-2 commands to run sequentially.

You MUST respond ONLY with a valid JSON object matching this schema:
{
  "status": "success" | "warning" | "error",
  "summary": "Clear summary of the result and structure changes",
  "suggestedCwd": "subfolder name or relative path to enter, or null to stay in current directory",
  "wayForward": "Actionable explanation of current state and what should be done next",
  "suggestedNextCommands": ["next_command_1", "next_command_2"]
}`;

    const auditRes = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        options: { temperature: 0.1, num_predict: 500 },
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (auditRes.ok) {
      const data = await auditRes.json();
      const content = data.message?.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        llmAudit = JSON.parse(jsonMatch[0]);
      }
    }
  } catch (err) {
    // LLM timeout or offline; fallback heuristic handles it gracefully
  }

  // Resolve final new CWD
  let finalNewCwd = currentDir;
  let finalRelativeCwd = path.relative(targetWorkspace, currentDir) || '.';

  const rawSuggested =
    llmAudit?.suggestedCwd ||
    (fallbackSuggestedCwd ? path.relative(currentDir, fallbackSuggestedCwd) : null);

  if (
    rawSuggested &&
    typeof rawSuggested === 'string' &&
    rawSuggested.toLowerCase() !== 'null' &&
    rawSuggested !== '.'
  ) {
    const resolvedPath = path.isAbsolute(rawSuggested)
      ? rawSuggested
      : path.resolve(currentDir, rawSuggested);
    const candidateBase = path.basename(resolvedPath);
    if (
      (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) ||
      createdDirs.includes(rawSuggested) ||
      createdDirs.includes(candidateBase) ||
      (fallbackSuggestedCwd && resolvedPath === fallbackSuggestedCwd)
    ) {
      finalNewCwd = resolvedPath;
      finalRelativeCwd = path.relative(targetWorkspace, resolvedPath) || '.';
    }
  } else if (fallbackSuggestedCwd) {
    finalNewCwd = fallbackSuggestedCwd;
    finalRelativeCwd = path.relative(targetWorkspace, fallbackSuggestedCwd) || '.';
  }

  return {
    command,
    exitCode,
    success: exitCode === 0,
    stdout,
    stderr,
    oldCwd: currentDir,
    newCwd: finalNewCwd,
    relativeCwd: finalRelativeCwd,
    createdDirs,
    createdFiles,
    status: llmAudit?.status || (exitCode === 0 ? 'success' : 'error'),
    summary: llmAudit?.summary || fallbackSummary,
    wayForward:
      llmAudit?.wayForward ||
      fallbackWayForward ||
      (exitCode === 0 ? 'Ready for next step.' : 'Please fix the command error before proceeding.'),
    suggestedNextCommands:
      llmAudit?.suggestedNextCommands && llmAudit.suggestedNextCommands.length > 0
        ? llmAudit.suggestedNextCommands
        : fallbackNextCommands,
  };
}

// 4.1 Execute a terminal command synchronously with stdout/stderr & error checking
app.post('/api/terminal/run', async (req, res) => {
  const { command, cwd, workspacePath, autoAudit = true, model } = req.body;
  if (!command) return res.status(400).json({ error: 'command is required' });

  const targetWorkspace = workspacePath || process.cwd();
  const workingDir = cwd && fs.existsSync(cwd) ? cwd : (workspaceCwdMap.get(targetWorkspace) || targetWorkspace);

  const beforeSnap = inspectDirectorySnapshot(workingDir);

  try {
    const { stdout, stderr } = await execPromise(command, {
      cwd: workingDir,
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const afterSnap = inspectDirectorySnapshot(workingDir);
    const createdDirs = afterSnap.dirs.filter((d) => !beforeSnap.dirs.includes(d));
    const createdFiles = afterSnap.files.filter((f) => !beforeSnap.files.includes(f));

    let audit = null;
    if (autoAudit) {
      audit = await auditCommandAndStructure({
        command,
        exitCode: 0,
        stdout,
        stderr,
        currentCwd: workingDir,
        workspacePath: targetWorkspace,
        createdDirs,
        createdFiles,
        model,
      });

      if (audit.newCwd !== workingDir) {
        workspaceCwdMap.set(targetWorkspace, audit.newCwd);
        broadcastToTerminal({ type: 'set_cwd', cwd: audit.newCwd });
      }
    }

    res.json({
      success: true,
      exitCode: 0,
      stdout,
      stderr,
      hasError: false,
      audit,
      newCwd: audit ? audit.newCwd : workingDir,
    });
  } catch (err) {
    const afterSnap = inspectDirectorySnapshot(workingDir);
    const createdDirs = afterSnap.dirs.filter((d) => !beforeSnap.dirs.includes(d));
    const createdFiles = afterSnap.files.filter((f) => !beforeSnap.files.includes(f));

    let audit = null;
    if (autoAudit) {
      audit = await auditCommandAndStructure({
        command,
        exitCode: err.code || 1,
        stdout: err.stdout || '',
        stderr: err.stderr || err.message,
        currentCwd: workingDir,
        workspacePath: targetWorkspace,
        createdDirs,
        createdFiles,
        model,
      });
    }

    res.json({
      success: false,
      exitCode: err.code || 1,
      stdout: err.stdout || '',
      stderr: err.stderr || err.message,
      hasError: true,
      audit,
      newCwd: workingDir,
    });
  }
});

// 4.2 Endpoint: Run commands synchronously in real-time, showing live output on screen, and audit each step
app.post('/api/terminal/run-live-stream', async (req, res) => {
  const {
    commands = [],
    workspacePath,
    initialCwd,
    model = 'granite4.2:8b',
    goalContext = '',
  } = req.body;

  if (!Array.isArray(commands) || commands.length === 0) {
    return res.status(400).json({ error: 'commands array is required' });
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

  res.on('close', () => {
    if (!res.writableEnded) {
      controller.abort();
    }
    activeGenerations.delete(controller);
  });

  const targetWorkspace = workspacePath || process.cwd();
  let activeCwd = initialCwd && fs.existsSync(initialCwd)
    ? initialCwd
    : (workspaceCwdMap.get(targetWorkspace) || targetWorkspace);

  sendEvent('queue_started', {
    total: commands.length,
    commands,
    currentCwd: activeCwd,
  });

  const executionResults = [];

  for (let i = 0; i < commands.length; i++) {
    if (controller.signal.aborted) {
      sendEvent('interrupted', { index: i, reason: 'Aborted by user' });
      break;
    }

    const rawCmd = commands[i].trim().replace(/^[$#]\s*/, '');
    if (!rawCmd) continue;

    sendEvent('command_started', {
      index: i,
      command: rawCmd,
      cwd: activeCwd,
      relativeCwd: path.relative(targetWorkspace, activeCwd) || '.',
    });

    const beforeSnap = inspectDirectorySnapshot(activeCwd);

    const runRes = await executeCommandLiveStream({
      command: rawCmd,
      cwd: activeCwd,
      onStdout: (chunk) => sendEvent('command_stdout', { index: i, chunk }),
      onStderr: (chunk) => sendEvent('command_stderr', { index: i, chunk }),
      signal: controller.signal,
    });

    sendEvent('command_finished', {
      index: i,
      exitCode: runRes.exitCode,
      success: runRes.success,
    });

    const afterSnap = inspectDirectorySnapshot(activeCwd);
    const createdDirs = afterSnap.dirs.filter((d) => !beforeSnap.dirs.includes(d));
    const createdFiles = afterSnap.files.filter((f) => !beforeSnap.files.includes(f));

    // Audit command and structure with LLM
    sendEvent('audit_started', { index: i, command: rawCmd });

    const audit = await auditCommandAndStructure({
      command: rawCmd,
      exitCode: runRes.exitCode,
      stdout: runRes.stdout,
      stderr: runRes.stderr,
      currentCwd: activeCwd,
      workspacePath: targetWorkspace,
      createdDirs,
      createdFiles,
      model,
      goalContext,
    });

    sendEvent('command_audited', { index: i, audit });

    appendIdeActivity(targetWorkspace, {
      type: 'command_audited',
      command: rawCmd,
      exitCode: runRes.exitCode,
      success: runRes.success,
      auditSummary: audit.summary,
      newCwd: audit.relativeCwd,
    });

    // Update active CWD if audit detected transition into new directory (e.g. blog)
    if (audit.newCwd !== activeCwd) {
      activeCwd = audit.newCwd;
      workspaceCwdMap.set(targetWorkspace, activeCwd);
      broadcastToTerminal({ type: 'set_cwd', cwd: activeCwd });
      sendEvent('cwd_changed', {
        newCwd: activeCwd,
        relativeCwd: audit.relativeCwd,
      });
    }

    executionResults.push({
      command: rawCmd,
      ...runRes,
      audit,
      cwd: activeCwd,
    });

    // If command failed critically, pause the queue to give user & LLM opportunity to review
    if (runRes.hasError) {
      sendEvent('queue_paused', {
        index: i,
        command: rawCmd,
        error: runRes.stderr || 'Command failed with non-zero exit code',
        audit,
      });
      break;
    }
  }

  sendEvent('queue_completed', {
    completed: !controller.signal.aborted,
    finalCwd: activeCwd,
    relativeCwd: path.relative(targetWorkspace, activeCwd) || '.',
    results: executionResults,
  });

  activeGenerations.delete(controller);
  res.end();
});

// 4.3 Endpoint: Dedicated command audit
app.post('/api/agent/audit-command', async (req, res) => {
  try {
    const {
      command,
      exitCode,
      stdout,
      stderr,
      currentCwd,
      workspacePath,
      createdDirs = [],
      createdFiles = [],
      model,
      goalContext,
    } = req.body;

    const audit = await auditCommandAndStructure({
      command,
      exitCode: exitCode ?? 0,
      stdout: stdout || '',
      stderr: stderr || '',
      currentCwd,
      workspacePath,
      createdDirs,
      createdFiles,
      model,
      goalContext,
    });

    res.json(audit);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4.4 Get/Set Active Working Directory for a Workspace
app.get('/api/agent/cwd', (req, res) => {
  const workspacePath = req.query.workspace || process.cwd();
  const cwd = workspaceCwdMap.get(workspacePath) || workspacePath;
  res.json({
    workspacePath,
    currentCwd: cwd,
    relativeCwd: path.relative(workspacePath, cwd) || '.',
  });
});

app.post('/api/agent/cwd', (req, res) => {
  const { workspacePath, newCwd } = req.body;
  if (!workspacePath || !newCwd) {
    return res.status(400).json({ error: 'workspacePath and newCwd are required' });
  }
  const resolved = path.isAbsolute(newCwd) ? newCwd : path.resolve(workspacePath, newCwd);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return res.status(400).json({ error: `Directory does not exist: ${newCwd}` });
  }
  workspaceCwdMap.set(workspacePath, resolved);
  broadcastToTerminal({ type: 'set_cwd', cwd: resolved });
  res.json({
    success: true,
    currentCwd: resolved,
    relativeCwd: path.relative(workspacePath, resolved) || '.',
  });
});

// WebSocket Terminal PTY stream for interactive bash terminal in the IDE
wss.on('connection', (ws) => {
  terminalClients.add(ws);
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
    terminalClients.delete(ws);
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

    const content = `# Aria IDE Workspace Context
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

function extractActionsFromText(text, expectedTargetFiles = []) {
  const fileActions = [];
  const bashActions = [];

  // 1. Explicit ```file:filename.ext or ```write:filename.ext or ```create:filename.ext
  const filePattern = /```(?:file|write|create):([^\n\r]+)[\r\n]([\s\S]*?)```/g;
  let match;
  while ((match = filePattern.exec(text)) !== null) {
    const rawPath = match[1].trim().replace(/^['"`]+|['"`]+$/g, '').replace(/^(\.\/|\/)/, '');
    const content = match[2];
    if (rawPath && !fileActions.some((f) => f.path === rawPath)) {
      fileActions.push({ path: rawPath, content });
    }
  }

  // 2. Standard bash/sh/shell blocks: ```(?:bash|sh|cmd|shell|zsh)(?::run)?[\r\n]([\s\S]*?)```
  const bashPattern = /```(?:bash|sh|cmd|shell|zsh)(?::run)?[\r\n]([\s\S]*?)```/gi;
  while ((match = bashPattern.exec(text)) !== null) {
    const rawBlock = match[1].trim();
    const lines = rawBlock.split(/[\r\n]+/);
    for (let line of lines) {
      line = line.trim().replace(/^[$#]\s*/, '').trim();
      // Ignore comments, empty lines, or solitary cd commands
      if (!line || line.startsWith('#') || line.startsWith('//')) continue;
      if (line.startsWith('cd ') && !line.includes('&&') && !line.includes(';')) continue;
      if (!bashActions.some((b) => b.command === line)) {
        bashActions.push({ command: line });
      }
    }
  }

  // 3. Fallback Heuristic: standard code block preceded by filename (e.g. "create a new JavaScript file ( script.js ) to handle... ```javascript")
  const heuristicPattern = /(?:create|file|in|named|modify|write|add|for|update)?\s*[`(]?([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]{1,8})[`)\]:]?\s*(?:to handle[^\n]*|:\s*|---\s*)?\n+```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/gi;
  while ((match = heuristicPattern.exec(text)) !== null) {
    const candidatePath = match[1].trim().replace(/^['"`]+|['"`]+$/g, '').replace(/^(\.\/|\/)/, '');
    const code = match[2];
    if (!candidatePath.includes(' ') && !fileActions.some((f) => f.path === candidatePath) && code.trim().length > 0) {
      const ext = path.extname(candidatePath).toLowerCase();
      if (['.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.json', '.py', '.php', '.rs', '.vue', '.sh', '.md', '.sql'].includes(ext)) {
        fileActions.push({ path: candidatePath, content: code });
      }
    }
  }

  // 4. Code block with first line comment containing filename: e.g. // index.js or /* style.css */ or <!-- index.html -->
  const blockWithCommentPattern = /```(?:[a-zA-Z0-9_-]+)?[\r\n]+(?:\/\/|#|<!--|\/\*)\s*([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]{1,8})(?:\s*-->|\s*\*\/)?[\r\n]([\s\S]*?)```/g;
  while ((match = blockWithCommentPattern.exec(text)) !== null) {
    const candidatePath = match[1].trim().replace(/^['"`]+|['"`]+$/g, '').replace(/^(\.\/|\/)/, '');
    const code = match[2];
    if (!candidatePath.includes(' ') && !fileActions.some((f) => f.path === candidatePath) && code.trim().length > 0) {
      const ext = path.extname(candidatePath).toLowerCase();
      if (['.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.json', '.py', '.php', '.rs', '.vue', '.sh', '.md', '.sql'].includes(ext)) {
        fileActions.push({ path: candidatePath, content: code });
      }
    }
  }

  // 5. Header or bold filename immediately before code block: e.g. ### `index.html`\n```html or **styles.css**\n```css
  const headerOrBoldPattern = /(?:###?\s+|[*_]{1,2}|`)([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]{1,8})(?:[*_]{1,2}|`|:)?[\r\n]+```(?:[a-zA-Z0-9_-]+)?[\r\n]([\s\S]*?)```/g;
  while ((match = headerOrBoldPattern.exec(text)) !== null) {
    const candidatePath = match[1].trim().replace(/^['"`]+|['"`]+$/g, '').replace(/^(\.\/|\/)/, '');
    const code = match[2];
    if (!candidatePath.includes(' ') && !fileActions.some((f) => f.path === candidatePath) && code.trim().length > 0) {
      const ext = path.extname(candidatePath).toLowerCase();
      if (['.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.json', '.py', '.php', '.rs', '.vue', '.sh', '.md', '.sql'].includes(ext)) {
        fileActions.push({ path: candidatePath, content: code });
      }
    }
  }

  // 6. JSON tool call emitted in text by smaller models
  const jsonToolPattern = /\{\s*"name"\s*:\s*"write_file"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?"path"\s*:\s*"([^"]+)"[\s\S]*?"content"\s*:\s*"([\s\S]*?)"\s*\}\s*\}/g;
  while ((match = jsonToolPattern.exec(text)) !== null) {
    const p = match[1].replace(/^['"`]+|['"`]+$/g, '').replace(/^(\.\/|\/)/, '');
    let c = match[2];
    try {
      c = JSON.parse(`"${c}"`);
    } catch (e) {}
    if (!fileActions.some((f) => f.path === p)) {
      fileActions.push({ path: p, content: c });
    }
  }

  // 7. Heuristic with expectedTargetFiles:
  // If target files were specified for this phase and haven't been matched yet:
  if (Array.isArray(expectedTargetFiles) && expectedTargetFiles.length > 0) {
    const missingTargets = expectedTargetFiles
      .map((t) => t.replace(/^['"`]+|['"`]+$/g, '').replace(/^(\.\/|\/)/, '').trim())
      .filter((t) => t && !fileActions.some((fa) => fa.path.toLowerCase() === t.toLowerCase() || fa.path.toLowerCase().endsWith('/' + t.toLowerCase())));

    if (missingTargets.length > 0) {
      const genericBlockPattern = /```([a-zA-Z0-9_-]+)?[\r\n]([\s\S]*?)```/g;
      let gMatch;
      while ((gMatch = genericBlockPattern.exec(text)) !== null) {
        const lang = (gMatch[1] || '').toLowerCase();
        const code = gMatch[2].trim();
        // Skip bash / terminal blocks
        if (['bash', 'sh', 'cmd', 'shell', 'zsh', 'terminal'].includes(lang)) continue;
        if (code.length < 15) continue;

        const blockIndex = gMatch.index;
        const precedingText = text.substring(Math.max(0, blockIndex - 300), blockIndex);

        let matchedTarget = null;
        for (const target of missingTargets) {
          if (precedingText.toLowerCase().includes(target.toLowerCase())) {
            matchedTarget = target;
            break;
          }
        }

        // If not mentioned directly, but there is only 1 missing target file and the code extension matches
        if (!matchedTarget && missingTargets.length === 1) {
          const onlyTarget = missingTargets[0];
          const targetExt = path.extname(onlyTarget).toLowerCase();
          const langMap = {
            js: '.js', javascript: '.js', ts: '.ts', typescript: '.ts',
            html: '.html', css: '.css', json: '.json', py: '.py', python: '.py'
          };
          if (langMap[lang] === targetExt || (!lang && code.length > 20)) {
            matchedTarget = onlyTarget;
          }
        }

        if (matchedTarget && !fileActions.some((f) => f.path === matchedTarget)) {
          fileActions.push({ path: matchedTarget, content: code });
          const idx = missingTargets.indexOf(matchedTarget);
          if (idx !== -1) missingTargets.splice(idx, 1);
        }
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
    let rawFiles = fileMatches
      ? fileMatches[1]
          .split(/[,;]/)
          .map((s) => s.replace(/[`*'"\\()]/g, '').trim())
          .filter(Boolean)
      : [];

    const validExts = new Set([
      '.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.json', '.py', '.md',
      '.env', '.sh', '.bash', '.yml', '.yaml', '.sql', '.svg', '.txt', '.php',
      '.rs', '.go', '.vue', '.svelte', '.xml'
    ]);
    const validExactNames = new Set([
      '.gitignore', '.npmignore', 'dockerfile', 'makefile', 'procfile',
      '.dockerignore', '.editorconfig', '.env.example'
    ]);

    const targetFiles = [];
    const seenFiles = new Set();
    for (const f of rawFiles) {
      const cleanF = f.replace(/^(\.\/|\/)/, '').trim();
      const lower = cleanF.toLowerCase();
      if (lower === 'package-lock.json' || lower === 'yarn.lock' || lower === 'pnpm-lock.yaml') continue;

      const ext = path.extname(lower);
      const isExact = validExactNames.has(lower);
      const hasValidExt = validExts.has(ext);

      if ((hasValidExt || isExact) && !seenFiles.has(cleanF)) {
        seenFiles.add(cleanF);
        targetFiles.push(cleanF);
      }
    }

    const cmdMatches = body.match(/Commands:?\s*([^\n]+)/i);
    let rawCmds = cmdMatches
      ? cmdMatches[1]
          .split(/[,;]/)
          .map((s) => s.replace(/[`*'"\\()]/g, '').replace(/^[$#]\s*/, '').trim())
          .filter(Boolean)
      : [];

    const commands = [];
    const seenCmds = new Set();
    for (const c of rawCmds) {
      if (c && !seenCmds.has(c) && !c.toLowerCase().startsWith('none')) {
        seenCmds.add(c);
        commands.push(c);
      }
    }

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

// Endpoint: Interrupt active execution with new guidance & dynamically revise the plan
app.post('/api/agent/interrupt', async (req, res) => {
  const {
    model,
    workspacePath,
    currentCwd,
    interruptionMessage,
    activePlan,
    completedPhases = [],
    executedCommands = [],
    writtenFiles = [],
  } = req.body;

  if (!interruptionMessage) {
    return res.status(400).json({ error: 'interruptionMessage is required' });
  }

  // 1. Abort any active streaming / generation operations
  let stopped = 0;
  for (const c of activeGenerations) {
    try {
      c.abort();
      stopped++;
    } catch (e) {}
  }
  activeGenerations.clear();

  const targetWorkspace = workspacePath || process.cwd();
  const effectiveCwd = currentCwd || (workspaceCwdMap.get(targetWorkspace) || targetWorkspace);

  // 2. Snapshot current workspace directory
  const tree = buildFileTree(effectiveCwd, 0, 2);
  const fileListSnippet = tree.map((t) => (t.isDirectory ? `📁 ${t.name}/` : `📄 ${t.name}`)).join('\n');

  const architectPrompt = `You are the Lead Software Architect of Aria IDE.
The user has INTERRUPTED execution mid-flight with new/updated requirements.

CURRENT SYSTEM & EXECUTION STATE:
- Active Working Directory: ${effectiveCwd} (relative: ${path.relative(targetWorkspace, effectiveCwd) || '.'})
- Current Files in Directory:
${fileListSnippet || '(Empty directory)'}
- Commands Already Executed:
${executedCommands.length > 0 ? executedCommands.map((c) => `- ${c.command} (exit: ${c.exitCode})`).join('\n') : 'None'}
- Files Already Created:
${writtenFiles.length > 0 ? writtenFiles.map((f) => `- ${f.path}`).join('\n') : 'None'}

USER INTERRUPTION & NEW INSTRUCTIONS:
"${interruptionMessage}"

EXISTING PLAN PHASES:
${activePlan ? JSON.stringify(activePlan.phases || [], null, 2) : 'None'}

TASK:
1. Audit what has already been created/executed. Do NOT re-create or re-run what is already done and valid.
2. Adapt and update the remaining phases and sequential commands based on the user's new instructions.
3. If the user changed the directory, stack, or tools, reflect that in the new phases.

Your response MUST be an updated Phased Implementation Plan following this exact markdown format:

# Implementation Plan (Updated via User Interruption)

## Overview
Summary of how the architecture and plan adapt to: "${interruptionMessage}".

## Phased Execution Roadmap

### Phase 1: [Phase Title]
- **Goal:** [What this phase accomplishes]
- **Target Files:** [Comma-separated file names with extensions, e.g. .env, package.json]
- **Commands:** [Comma-separated commands to execute, e.g. composer require ..., npm install ...]
- **Checklist:**
- [ ] [Specific actionable step]
- [ ] [Specific actionable step]

(Provide remaining phases as needed)`;

  try {
    const selectedModel = model || 'granite4.2:8b';
    const ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: selectedModel,
        messages: [{ role: 'user', content: architectPrompt }],
        stream: false,
        options: { temperature: 0.2, num_predict: 4096 },
      }),
    });

    if (!ollamaRes.ok) {
      const err = await ollamaRes.text();
      throw new Error(`Ollama error: ${err}`);
    }

    const data = await ollamaRes.json();
    const planMarkdown = data.message?.content || '';
    const phases = parsePhasesFromPlan(planMarkdown);

    // Parse checklist tasks
    const tasks = [];
    const taskRegex = /- \[(?: |x)\] ([^\n]+)/g;
    let tMatch;
    let tIdx = 1;
    while ((tMatch = taskRegex.exec(planMarkdown)) !== null) {
      tasks.push({
        id: `task-revised-${tIdx}-${Date.now()}`,
        title: tMatch[1].trim(),
        completed: false,
      });
      tIdx++;
    }

    // Save updated plan to workspace
    const planFileAbs = path.join(targetWorkspace, 'IMPLEMENTATION_PLAN.md');
    try {
      fs.writeFileSync(planFileAbs, planMarkdown, 'utf8');
    } catch (e) {}

    appendIdeActivity(targetWorkspace, {
      type: 'interrupted',
      title: 'Plan Updated via User Interruption',
      auditSummary: interruptionMessage,
    });

    res.json({
      success: true,
      updatedPlanMarkdown: planMarkdown,
      phases,
      tasks,
      wayForward: `AI updated the plan to incorporate: "${interruptionMessage}". You can now proceed with Phase 1 of the updated plan.`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

  const architectPrompt = `You are the Lead Software Architect of Aria IDE.
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
- **Target Files:** [Comma-separated file names with extensions, e.g. package.json, .gitignore. DO NOT list npm package names or library names here, ONLY real filenames to create!]
- **Commands:** [Comma-separated commands to execute, e.g. npm init -y, npm install express]
- **Checklist:**
- [ ] [Specific actionable step]
- [ ] [Specific actionable step]

### Phase 2: [Phase Title]
- **Goal:** [What this phase accomplishes]
- **Target Files:** [Comma-separated file names with extensions, e.g. index.js, calculator.js]
- **Commands:** [Comma-separated commands, or None]
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
        keep_alive: '15m',
        options: {
          temperature: 0.2,
          num_predict: 2048,
          num_ctx: 4096,
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
      targetFiles = [],
      expectedCommands = [],
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

    let systemInstruction = `You are the Autonomous Software Engineer of the Aria IDE.
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
The Aria backend will automatically create the files on disk and execute the commands.`;

    if (thinkingEnabled) {
      systemInstruction += `\nInclude deep reasoning steps inside <think>...</think> tags before writing your answer.`;
    }

    // Smart context pruning: keeps last 4 messages and compresses massive code blocks
    const prunedMessages = [{ role: 'system', content: systemInstruction }];
    const recentHistory = (conversationHistory || []).slice(-4);
    for (const msg of recentHistory) {
      let content = msg.content || '';
      if (content.length > 2000) {
        content = content.replace(/```(?:file:[^\n]+|[\w]+)?\n([\s\S]{250,}?)```/g, () => {
          return '```\n[Code block omitted: file already synced to disk]\n```';
        });
      }
      prunedMessages.push({ role: msg.role, content });
    }
    prunedMessages.push({ role: 'user', content: prompt });

    sendEvent('status', { status: 'Connecting to local LLM...' });

    // Call Ollama streaming API with Tools (for supported models) & AbortSignal
    const ollamaRequestBody = {
      model,
      messages: prunedMessages,
      stream: true,
      keep_alive: '15m',
      options: {
        temperature: 0.2,
        num_predict: 4096,
        num_ctx: 4096,
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

    let ollamaRes;
    try {
      ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(ollamaRequestBody),
      });
    } catch (fetchErr) {
      if (controller.signal.aborted) {
        sendEvent('status', { status: 'Stopped' });
        res.end();
        return;
      }
      sendEvent('error', {
        error: `Local LLM connection dropped (${fetchErr.message}). Ollama may be running out of memory or busy. The phase has paused — you can click 'Proceed' to resume safely.`,
      });
      res.end();
      return;
    }

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
        let streamCwd = workspaceCwdMap.get(targetWorkspace) || targetWorkspace;
        sendEvent('command_started', { command: args.command, cwd: streamCwd });
        const beforeSnap = inspectDirectorySnapshot(streamCwd);
        const resCmd = await executeCommandLiveStream({
          command: args.command,
          cwd: streamCwd,
          onStdout: (chunk) => sendEvent('command_stdout', { command: args.command, chunk }),
          onStderr: (chunk) => sendEvent('command_stderr', { command: args.command, chunk }),
          signal: controller.signal,
        });
        sendEvent('command_finished', { command: args.command, exitCode: resCmd.exitCode, success: resCmd.success });

        const afterSnap = inspectDirectorySnapshot(streamCwd);
        const createdDirs = afterSnap.dirs.filter((d) => !beforeSnap.dirs.includes(d));
        const createdFiles = afterSnap.files.filter((f) => !beforeSnap.files.includes(f));

        const audit = await auditCommandAndStructure({
          command: args.command,
          exitCode: resCmd.exitCode,
          stdout: resCmd.stdout,
          stderr: resCmd.stderr,
          currentCwd: streamCwd,
          workspacePath: targetWorkspace,
          createdDirs,
          createdFiles,
          model,
        });

        sendEvent('command_audited', audit);
        if (audit.newCwd !== streamCwd) {
          streamCwd = audit.newCwd;
          workspaceCwdMap.set(targetWorkspace, streamCwd);
          broadcastToTerminal({ type: 'set_cwd', cwd: streamCwd });
          sendEvent('cwd_changed', { newCwd: streamCwd, relativeCwd: audit.relativeCwd });
        }

        executedCommands.push({ command: args.command, ...resCmd, audit });
        appendIdeActivity(targetWorkspace, {
          type: 'command_audited',
          command: args.command,
          exitCode: resCmd.exitCode,
          success: resCmd.success,
          auditSummary: audit.summary,
          newCwd: audit.relativeCwd,
        });
        sendEvent('command_executed', { command: args.command, ...resCmd, audit });
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
      const { fileActions, bashActions } = extractActionsFromText(accumulatedContent, targetFiles);

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
        let streamCwd = workspaceCwdMap.get(targetWorkspace) || targetWorkspace;

        // Run any commands extracted from the model's text synchronously one after another
        for (const ba of bashActions) {
          if (!executedCommands.some((c) => c.command === ba.command)) {
            sendEvent('command_started', { command: ba.command, cwd: streamCwd });
            const beforeSnap = inspectDirectorySnapshot(streamCwd);

            const resCmd = await executeCommandLiveStream({
              command: ba.command,
              cwd: streamCwd,
              onStdout: (chunk) => sendEvent('command_stdout', { command: ba.command, chunk }),
              onStderr: (chunk) => sendEvent('command_stderr', { command: ba.command, chunk }),
              signal: controller.signal,
            });

            sendEvent('command_finished', { command: ba.command, exitCode: resCmd.exitCode, success: resCmd.success });

            const afterSnap = inspectDirectorySnapshot(streamCwd);
            const createdDirs = afterSnap.dirs.filter((d) => !beforeSnap.dirs.includes(d));
            const createdFiles = afterSnap.files.filter((f) => !beforeSnap.files.includes(f));

            const audit = await auditCommandAndStructure({
              command: ba.command,
              exitCode: resCmd.exitCode,
              stdout: resCmd.stdout,
              stderr: resCmd.stderr,
              currentCwd: streamCwd,
              workspacePath: targetWorkspace,
              createdDirs,
              createdFiles,
              model,
            });

            sendEvent('command_audited', audit);
            if (audit.newCwd !== streamCwd) {
              streamCwd = audit.newCwd;
              workspaceCwdMap.set(targetWorkspace, streamCwd);
              broadcastToTerminal({ type: 'set_cwd', cwd: streamCwd });
              sendEvent('cwd_changed', { newCwd: streamCwd, relativeCwd: audit.relativeCwd });
            }

            executedCommands.push({ command: ba.command, ...resCmd, audit });
            appendIdeActivity(targetWorkspace, {
              type: 'command_audited',
              command: ba.command,
              exitCode: resCmd.exitCode,
              success: resCmd.success,
              auditSummary: audit.summary,
              newCwd: audit.relativeCwd,
            });
            sendEvent('command_executed', { command: ba.command, ...resCmd, audit });
          }
        }

        // Run expectedCommands from the phase plan that were not yet executed
        if (Array.isArray(expectedCommands)) {
          for (const ec of expectedCommands) {
            const cleanCmd = ec.trim().replace(/^[$#]\s*/, '');
            if (cleanCmd && !executedCommands.some((c) => c.command === cleanCmd)) {
              sendEvent('command_started', { command: cleanCmd, cwd: streamCwd });
              const beforeSnap = inspectDirectorySnapshot(streamCwd);

              const resCmd = await executeCommandLiveStream({
                command: cleanCmd,
                cwd: streamCwd,
                onStdout: (chunk) => sendEvent('command_stdout', { command: cleanCmd, chunk }),
                onStderr: (chunk) => sendEvent('command_stderr', { command: cleanCmd, chunk }),
                signal: controller.signal,
              });

              sendEvent('command_finished', { command: cleanCmd, exitCode: resCmd.exitCode, success: resCmd.success });

              const afterSnap = inspectDirectorySnapshot(streamCwd);
              const createdDirs = afterSnap.dirs.filter((d) => !beforeSnap.dirs.includes(d));
              const createdFiles = afterSnap.files.filter((f) => !beforeSnap.files.includes(f));

              const audit = await auditCommandAndStructure({
                command: cleanCmd,
                exitCode: resCmd.exitCode,
                stdout: resCmd.stdout,
                stderr: resCmd.stderr,
                currentCwd: streamCwd,
                workspacePath: targetWorkspace,
                createdDirs,
                createdFiles,
                model,
              });

              sendEvent('command_audited', audit);
              if (audit.newCwd !== streamCwd) {
                streamCwd = audit.newCwd;
                workspaceCwdMap.set(targetWorkspace, streamCwd);
                broadcastToTerminal({ type: 'set_cwd', cwd: streamCwd });
                sendEvent('cwd_changed', { newCwd: streamCwd, relativeCwd: audit.relativeCwd });
              }

              executedCommands.push({ command: cleanCmd, ...resCmd, audit });
              appendIdeActivity(targetWorkspace, {
                type: 'command_audited',
                command: cleanCmd,
                exitCode: resCmd.exitCode,
                success: resCmd.success,
                auditSummary: audit.summary,
                newCwd: audit.relativeCwd,
              });
              sendEvent('command_executed', { command: cleanCmd, ...resCmd, audit });
            }
          }
        }
      }

      // Check if targetFiles were created on disk by commands (e.g. npm init creating package.json)
      if (Array.isArray(targetFiles)) {
        for (const tf of targetFiles) {
          const cleanTf = tf.replace(/^['"`]+|['"`]+$/g, '').replace(/^(\.\/|\/)/, '').trim();
          if (!cleanTf) continue;
          const targetAbs = path.resolve(targetWorkspace, cleanTf);
          if (fs.existsSync(targetAbs) && !writtenFiles.some((w) => w.relPath === cleanTf)) {
            try {
              const stat = fs.statSync(targetAbs);
              if (!stat.isDirectory()) {
                const content = fs.readFileSync(targetAbs, 'utf8');
                const fileInfo = {
                  absPath: targetAbs,
                  relPath: cleanTf,
                  size: stat.size,
                  originalContent: '',
                  isNewFile: true,
                  content,
                };
                writtenFiles.push(fileInfo);
                sendEvent('file_written', {
                  ...fileInfo,
                  source: 'disk_sync',
                });
              }
            } catch (e) {}
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
  console.log(`[Aria IDE Backend] Listening on http://localhost:${PORT}`);
  console.log(`[Aria IDE Backend] WebSocket Terminal ready on ws://localhost:${PORT}`);
});
