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
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'target', '.cache', '.gemini']);

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

app.post('/api/agent/stream', async (req, res) => {
  const { model, prompt, workspacePath, thinkingEnabled, mode, conversationHistory = [] } = req.body;

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
    // Provide repository context & tools schema in system prompt
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
    const composerPath = path.join(targetWorkspace, 'composer.json');
    if (fs.existsSync(composerPath)) {
      try {
        const comp = JSON.parse(fs.readFileSync(composerPath, 'utf8'));
        manifestInfo += `\ncomposer.json dependencies: ${JSON.stringify(comp.require)}`;
      } catch (e) {}
    }

    let systemInstruction = `You are the Autonomous Software Engineer of the Antigravity IDE.
You are running on Linux Ubuntu with direct access to terminal execution and filesystem manipulation.
Current workspace directory: ${targetWorkspace}

Workspace File Tree:
${fileListSnippet || '(Empty workspace)'}
${manifestInfo}

STRICT OPERATIONAL DIRECTIVES:
1. NEVER instruct the user what commands to run or how to build things. Do NOT say "You can install...", "First you need to...", or "Here are the steps you should follow...". The user will NOT run anything manually.
2. YOU must directly execute the work using actionable blocks.
3. Every response MUST follow this structured workflow:

### Implementation Plan
Always start by identifying the clear steps as a checklist to maintain focus and prevent hallucinations:
- [ ] Step 1: [Specific setup or scaffolding step]
- [ ] Step 2: [Specific file or component to create/modify]
- [ ] Step 3: [Build or verification step]

### Actions
Immediately emit the executable commands and file contents for the IDE to run and write:
- To run terminal commands (scaffolding, installing packages, running migrations, building):
\`\`\`bash:run
command to run
\`\`\`

- To create or update files in the workspace:
\`\`\`file:relative/path/to/file.ext
[complete file code here]
\`\`\`

4. Provide real, complete code without placeholders. The IDE backend automatically runs your bash commands and writes your files to the disk.`;

    if (thinkingEnabled) {
      systemInstruction += `\nInclude deep reasoning steps inside <think>...</think> tags before writing your answer.`;
    }

    const messages = [
      { role: 'system', content: systemInstruction },
      ...conversationHistory,
      { role: 'user', content: prompt },
    ];

    sendEvent('status', { status: 'Connecting to local LLM...' });

    // Call Ollama streaming API with AbortSignal and max tokens
    const ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        options: {
          temperature: 0.2,
          num_predict: 3072,
          stop: ['<|endoftext|>', '<|im_end|>', '\n\nUser:', '\n\nHuman:'],
        },
      }),
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
          
          if (delta) {
            accumulatedContent += delta;
            
            // Check for <think> and </think> tags
            if (delta.includes('<think>')) inThinkTag = true;
            if (inThinkTag) {
              accumulatedThinking += delta;
            }
            if (delta.includes('</think>')) inThinkTag = false;

            sendEvent('chunk', {
              chunk: delta,
              isThinking: inThinkTag,
            });
          }

          if (parsed.done) {
            sendEvent('done', {
              totalContent: accumulatedContent,
              totalDuration: parsed.total_duration,
              evalCount: parsed.eval_count,
            });
          }
        } catch (e) {}
      }
    }

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
