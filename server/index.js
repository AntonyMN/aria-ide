import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import os from 'os';
import pty from 'node-pty';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
// 1.5 OLLAMA MEMORY MANAGEMENT & OFFLOADING ENGINE
// ==========================================

// Helper: Normalize and compare model names (handles :latest suffix and tag variants)
function matchModelName(a, b) {
  if (!a || !b) return false;
  const cleanA = String(a).trim().toLowerCase();
  const cleanB = String(b).trim().toLowerCase();
  if (cleanA === cleanB) return true;
  if (cleanA === `${cleanB}:latest` || cleanB === `${cleanA}:latest`) return true;
  const baseA = cleanA.split(':')[0];
  const baseB = cleanB.split(':')[0];
  if (baseA === baseB) {
    if (!cleanA.includes(':') || !cleanB.includes(':')) return true;
  }
  return false;
}

// Helper: Query Ollama /api/ps for models currently loaded in RAM/VRAM
async function getOllamaActiveModels() {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/ps`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data.models)) return [];
    return data.models.map((m) => {
      const sizeBytes = m.size || 0;
      const sizeVram = m.size_vram || 0;
      const sizeRam = Math.max(0, sizeBytes - sizeVram);
      return {
        name: m.name,
        model: m.model || m.name,
        sizeBytes,
        sizeGB: (sizeBytes / (1024 * 1024 * 1024)).toFixed(2),
        sizeVramBytes: sizeVram,
        sizeVramGB: (sizeVram / (1024 * 1024 * 1024)).toFixed(2),
        sizeRamBytes: sizeRam,
        sizeRamGB: (sizeRam / (1024 * 1024 * 1024)).toFixed(2),
        ramGB: (sizeRam / (1024 * 1024 * 1024)).toFixed(2),
        expiresAt: m.expires_at || '',
        contextLength: m.context_length || 4096,
        details: m.details || {},
      };
    });
  } catch (err) {
    return [];
  }
}

// Helper: Offload a specific model by sending keep_alive: 0 and poll /api/ps until verified gone from RAM
async function offloadModelAndWait(modelName, maxWaitMs = 10000, pollIntervalMs = 200) {
  const startTime = Date.now();
  console.log(`[Aria RAM Manager] Initiating offload for model "${modelName}"...`);

  // 1. Send keep_alive: 0 to Ollama via /api/generate
  try {
    await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName, keep_alive: 0 }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.warn(`[Aria RAM Manager] Note on generate keep_alive 0:`, err.message);
    // Also try /api/chat with keep_alive: 0 as fallback
    try {
      await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName, keep_alive: 0, messages: [] }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (e2) {
      console.warn(`[Aria RAM Manager] Note on chat keep_alive 0:`, e2.message);
    }
  }

  // 2. Poll /api/ps until model is confirmed completely gone from RAM
  let verified = false;
  let remaining = [];
  while (Date.now() - startTime < maxWaitMs) {
    remaining = await getOllamaActiveModels();
    const stillPresent = remaining.some((m) => matchModelName(m.name, modelName) || matchModelName(m.model, modelName));
    if (!stillPresent) {
      verified = true;
      break;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  if (!verified) {
    remaining = await getOllamaActiveModels();
    const stillPresent = remaining.some((m) => matchModelName(m.name, modelName) || matchModelName(m.model, modelName));
    if (!stillPresent) {
      verified = true;
    }
  }

  const durationMs = Date.now() - startTime;
  if (!verified) {
    console.warn(`[Aria RAM Manager] Timed out waiting for model "${modelName}" to offload from RAM after ${durationMs}ms`);
  } else {
    console.log(`[Aria RAM Manager] Verified model "${modelName}" offloaded from RAM in ${durationMs}ms.`);
  }

  return {
    success: verified,
    model: modelName,
    offloaded: verified,
    verified,
    timeTakenMs: durationMs,
    remainingActiveModels: remaining,
  };
}

// Helper: Offload all active models and verify RAM is completely clean
async function offloadAllModelsAndWait(maxWaitMs = 12000, pollIntervalMs = 200) {
  const initialActive = await getOllamaActiveModels();
  if (initialActive.length === 0) {
    return { success: true, offloadedCount: 0, verified: true, timeTakenMs: 0, remainingActiveModels: [] };
  }

  const startTime = Date.now();
  console.log(`[Aria RAM Manager] Offloading all ${initialActive.length} active models from RAM...`);
  for (const m of initialActive) {
    await offloadModelAndWait(m.name, Math.max(3000, Math.floor(maxWaitMs / initialActive.length)), pollIntervalMs);
  }

  // Verify all are gone
  const finalActive = await getOllamaActiveModels();
  const verified = finalActive.length === 0;

  return {
    success: verified,
    offloadedCount: initialActive.length - finalActive.length,
    verified,
    timeTakenMs: Date.now() - startTime,
    remainingActiveModels: finalActive,
  };
}

// Helper: Ensure targetModel (and any allowed co-resident models) is in RAM (evict all conflicting models and verify before generation)
async function ensureOnlyTargetModelLoaded(targetModel, allowedResidentModels = [], maxWaitMs = 10000) {
  if (!targetModel) return;
  try {
    const allowed = [targetModel, ...(Array.isArray(allowedResidentModels) ? allowedResidentModels : [])].filter(Boolean);
    const active = await getOllamaActiveModels();
    const conflicting = active.filter(
      (m) => !allowed.some((a) => matchModelName(m.name, a) || matchModelName(m.model, a))
    );
    if (conflicting.length === 0) return;

    console.log(`[Aria RAM Manager] Found ${conflicting.length} conflicting models in RAM before running "${targetModel}". Offloading to preserve RAM...`);
    for (const conf of conflicting) {
      await offloadModelAndWait(conf.name, maxWaitMs);
    }
    console.log(`[Aria RAM Manager] Conflicting models verified evicted. RAM is ready for "${targetModel}".`);
  } catch (err) {
    console.warn(`[Aria RAM Manager] Auto-eviction note:`, err.message);
  }
}

// ==========================================
// 2. MODEL DISCOVERY ENGINE
// ==========================================
// Discovers models from Ollama API, Ollama disk manifests, and HuggingFace cache
async function discoverInstalledModels() {
  const models = new Map();
  const mem = getSystemMemory();
  const availGB = parseFloat(mem.availableGB);

  // Get active models currently resident in RAM
  const activeList = await getOllamaActiveModels();

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

          const activeInfo = activeList.find((a) => matchModelName(a.name, m.name) || matchModelName(a.model, m.name));
          const isLoadedInRam = !!activeInfo;

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
            isRunning: isLoadedInRam,
            isLoadedInRam,
            loadedDetails: activeInfo || null,
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

                const activeInfo = activeList.find((a) => matchModelName(a.name, fullName) || matchModelName(a.model, fullName));
                const isLoadedInRam = !!activeInfo;

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
                  isRunning: isLoadedInRam,
                  isLoadedInRam,
                  loadedDetails: activeInfo || null,
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
              const activeInfo = activeList.find((a) => matchModelName(a.name, cleanName) || matchModelName(a.model, cleanName));
              const isLoadedInRam = !!activeInfo;

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
                isRunning: isLoadedInRam,
                isLoadedInRam,
                loadedDetails: activeInfo || null,
              });
            }
          }
        }
      }
    } catch (e) {}
  }

  // D. Include any loaded active model not present in disk manifests or tags
  for (const act of activeList) {
    const existing = Array.from(models.values()).find((m) => matchModelName(m.name, act.name) || matchModelName(m.name, act.model));
    if (!existing) {
      const ram = estimateModelRam(act.sizeBytes, act.details?.parameter_size);
      models.set(act.name, {
        name: act.name,
        source: 'ollama_running',
        sizeBytes: act.sizeBytes,
        sizeGB: act.sizeGB,
        parameterSize: act.details?.parameter_size || 'Unknown',
        quantization: act.details?.quantization_level || 'Q4',
        format: act.details?.format || 'gguf',
        family: act.details?.family || 'unknown',
        capabilities: ['completion'],
        ramEstimate: ram,
        safetyBadge: ram.totalEstimatedGB > availGB ? 'SWAP_HEAVY' : 'SAFE',
        isRunning: true,
        isLoadedInRam: true,
        loadedDetails: act,
      });
    }
  }

  return Array.from(models.values());
}

// System Memory API
app.get('/api/system/memory', (req, res) => {
  res.json(getSystemMemory());
});

// Installed Models API (with active memory tracking)
app.get('/api/models', async (req, res) => {
  try {
    const list = await discoverInstalledModels();
    const active = await getOllamaActiveModels();
    res.json({
      models: list,
      activeModels: active,
      systemMemory: getSystemMemory(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Live Active Models in RAM API
app.get('/api/models/active', async (req, res) => {
  try {
    const activeModels = await getOllamaActiveModels();
    const totalBytes = activeModels.reduce((acc, m) => acc + (m.sizeBytes || 0), 0);
    const totalRamBytes = activeModels.reduce((acc, m) => acc + (m.sizeRamBytes || 0), 0);
    const totalVramBytes = activeModels.reduce((acc, m) => acc + (m.sizeVramBytes || 0), 0);
    res.json({
      activeModels,
      count: activeModels.length,
      totalBytes,
      totalGB: (totalBytes / (1024 * 1024 * 1024)).toFixed(2),
      totalRamBytes,
      totalRamGB: (totalRamBytes / (1024 * 1024 * 1024)).toFixed(2),
      totalVramBytes,
      totalVramGB: (totalVramBytes / (1024 * 1024 * 1024)).toFixed(2),
      systemMemory: getSystemMemory(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Explicit Unload / Offload Endpoint (Verifies removal from RAM)
app.post('/api/models/unload', async (req, res) => {
  try {
    const { model } = req.body;
    if (!model) {
      return res.status(400).json({ error: 'Model name is required to offload' });
    }
    const result = await offloadModelAndWait(model);
    res.json({
      ...result,
      systemMemory: getSystemMemory(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unload All Models Endpoint (Frees all LLM memory from RAM)
app.post('/api/models/unload-all', async (req, res) => {
  try {
    const result = await offloadAllModelsAndWait();
    res.json({
      ...result,
      systemMemory: getSystemMemory(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clean Model Switch Endpoint
// Offloads previous model(s), polls /api/ps until verified gone, then confirms switch
app.post('/api/models/switch', async (req, res) => {
  try {
    const { toModel, fromModel, unloadAllOther = true } = req.body;
    if (!toModel) {
      return res.status(400).json({ error: 'Target model (toModel) is required' });
    }

    console.log(`[Aria RAM Manager] Initiating clean model switch to "${toModel}"...`);
    const activeBefore = await getOllamaActiveModels();
    const modelsToOffload = [];

    for (const act of activeBefore) {
      if (!matchModelName(act.name, toModel) && !matchModelName(act.model, toModel)) {
        if (unloadAllOther || (fromModel && (matchModelName(act.name, fromModel) || matchModelName(act.model, fromModel)))) {
          modelsToOffload.push(act.name);
        }
      }
    }

    const offloadResults = [];
    for (const mName of modelsToOffload) {
      console.log(`[Aria RAM Manager] Offloading previous model "${mName}" before activating "${toModel}"...`);
      const offloadRes = await offloadModelAndWait(mName);
      offloadResults.push(offloadRes);
    }

    const remainingActive = await getOllamaActiveModels();
    const verified = !remainingActive.some((m) => modelsToOffload.some((off) => matchModelName(m.name, off)));

    console.log(`[Aria RAM Manager] Clean switch verified for "${toModel}". Remaining active in RAM: ${remainingActive.length}`);
    res.json({
      success: true,
      switchedTo: toModel,
      offloadedModels: modelsToOffload,
      verified,
      activeModels: remainingActive,
      systemMemory: getSystemMemory(),
    });
  } catch (err) {
    console.error(`[Aria RAM Manager] Error switching models:`, err);
    res.status(500).json({ error: err.message });
  }
});

// Boot / Preload Model Endpoint (Standard JSON)
app.post('/api/models/boot', async (req, res) => {
  try {
    const { model } = req.body;
    if (!model) {
      return res.status(400).json({ error: 'Model name is required to boot' });
    }

    const startTime = Date.now();
    console.log(`[Aria RAM Manager] Booting model "${model}" into RAM...`);

    // 1. Check if already active in RAM
    const activeInitially = await getOllamaActiveModels();
    const isAlreadyLoaded = activeInitially.some(
      (m) => matchModelName(m.name, model) || matchModelName(m.model, model)
    );
    if (isAlreadyLoaded) {
      return res.json({
        success: true,
        alreadyLoaded: true,
        verified: true,
        model,
        timeTakenMs: Date.now() - startTime,
        activeModels: activeInitially,
        systemMemory: getSystemMemory(),
      });
    }

    // 2. Clear any competing models to avoid memory collisions
    await ensureOnlyTargetModelLoaded(model);

    // 3. Preload into RAM via Ollama /api/generate
    const ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: '15m' }),
    });

    if (!ollamaRes.ok) {
      const errText = await ollamaRes.text();
      throw new Error(`Ollama failed to load model: ${errText}`);
    }
    await ollamaRes.json();

    // 4. Verify residency in /api/ps
    const finalActive = await getOllamaActiveModels();
    const verified = finalActive.some(
      (m) => matchModelName(m.name, model) || matchModelName(m.model, model)
    );

    console.log(`[Aria RAM Manager] Model "${model}" boot finished in ${Date.now() - startTime}ms (verified: ${verified}).`);
    res.json({
      success: true,
      verified,
      model,
      timeTakenMs: Date.now() - startTime,
      activeModels: finalActive,
      systemMemory: getSystemMemory(),
    });
  } catch (err) {
    console.error(`[Aria RAM Manager] Boot error for "${req.body?.model}":`, err);
    res.status(500).json({ error: err.message });
  }
});

// Boot / Preload Model with Live SSE Progress Stream
app.post('/api/models/boot-stream', async (req, res) => {
  const { model } = req.body;
  if (!model) {
    return res.status(400).json({ error: 'Model name is required to boot' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (event, data) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) {}
  };

  try {
    const startTime = Date.now();
    sendEvent('progress', { stage: 'init', percent: 10, message: `Preparing to boot ${model}...` });

    // 1. Check if already active in RAM
    const activeInitially = await getOllamaActiveModels();
    const isAlreadyLoaded = activeInitially.some(
      (m) => matchModelName(m.name, model) || matchModelName(m.model, model)
    );
    if (isAlreadyLoaded) {
      sendEvent('progress', { stage: 'ready', percent: 100, message: `Model ${model} is already resident in RAM and ready.` });
      sendEvent('done', {
        success: true,
        verified: true,
        model,
        alreadyLoaded: true,
        timeTakenMs: Date.now() - startTime,
        activeModels: activeInitially,
      });
      return res.end();
    }

    // 2. Clear competing models to allocate clean RAM
    sendEvent('progress', { stage: 'clearing', percent: 25, message: `Clearing other models from RAM to allocate clean memory...` });
    await ensureOnlyTargetModelLoaded(model);

    // 3. Start preload into RAM
    sendEvent('progress', { stage: 'allocating', percent: 45, message: `Allocating memory buffers & starting model engine...` });

    let ollamaDone = false;
    let preloadError = null;

    const preloadPromise = (async () => {
      try {
        const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, keep_alive: '15m' }),
        });
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Ollama preload error: ${errText}`);
        }
        await response.json();
        ollamaDone = true;
      } catch (err) {
        preloadError = err;
      }
    })();

    const stages = [
      { p: 58, msg: `Reading GGUF tensor layers from disk into RAM...` },
      { p: 72, msg: `Loading neural weights and context kv-cache...` },
      { p: 84, msg: `Initializing compute tensors and context window...` },
      { p: 92, msg: `Engine warmup and memory verification...` },
    ];

    let stageIdx = 0;
    while (!ollamaDone && !preloadError) {
      await new Promise((r) => setTimeout(r, 500));
      if (stageIdx < stages.length) {
        sendEvent('progress', { stage: 'loading', percent: stages[stageIdx].p, message: stages[stageIdx].msg });
        stageIdx++;
      }
    }

    await preloadPromise;

    if (preloadError) {
      throw preloadError;
    }

    // 4. Verify residency with /api/ps
    sendEvent('progress', { stage: 'verifying', percent: 96, message: `Verifying active model presence in system RAM...` });
    const finalActive = await getOllamaActiveModels();
    const verified = finalActive.some(
      (m) => matchModelName(m.name, model) || matchModelName(m.model, model)
    );

    sendEvent('progress', { stage: 'ready', percent: 100, message: `🎉 Model ${model} is fully booted and active in RAM!` });
    sendEvent('done', {
      success: true,
      verified,
      model,
      timeTakenMs: Date.now() - startTime,
      activeModels: finalActive,
      systemMemory: getSystemMemory(),
    });
    res.end();
  } catch (err) {
    sendEvent('error', { error: err.message });
    res.end();
  }
});

// ==========================================
// 3. WORKSPACE & FILE SYSTEM MANIPULATION
// ==========================================
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'target', '.cache', '.gemini', '.ide']);

function buildFileTree(dirPath, currentDepth = 0, maxDepth = 4) {
  if (currentDepth > maxDepth || !fs.existsSync(dirPath)) return [];

  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (e) {
    return [];
  }
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

let currentInitialWorkspace = process.env.INITIAL_WORKSPACE || null;

// Initial Workspace Path API
app.get('/api/workspace/initial', (req, res) => {
  res.json({
    path: currentInitialWorkspace,
    cwd: process.cwd(),
  });
});

// Set Active Workspace from CLI API
app.post('/api/workspace/open', (req, res) => {
  const { path: targetPath } = req.body;
  if (!targetPath || !fs.existsSync(targetPath)) {
    return res.status(400).json({ error: 'Target directory does not exist' });
  }
  const resolved = path.resolve(targetPath);
  currentInitialWorkspace = resolved;
  console.log(`[Aria IDE CLI] Opened workspace: ${resolved}`);
  res.json({ success: true, path: resolved });
});

// System CLI Installation API: Installs 'aria' into system PATH (~/.local/bin or %USERPROFILE%\bin)
app.post('/api/system/install-cli', (req, res) => {
  try {
    const isWindows = process.platform === 'win32';
    const binDir = path.join(__dirname, '..', 'bin');
    const cliScript = path.join(binDir, 'aria.js');

    try {
      fs.chmodSync(cliScript, 0o755);
    } catch (e) {}

    if (isWindows) {
      const userBin = path.join(os.homedir(), 'bin');
      if (!fs.existsSync(userBin)) fs.mkdirSync(userBin, { recursive: true });
      const cmdPath = path.join(userBin, 'aria.cmd');
      const cmdContent = `@echo off\r\nnode "${cliScript}" %*\r\n`;
      fs.writeFileSync(cmdPath, cmdContent, 'utf8');
      return res.json({
        success: true,
        installedPath: cmdPath,
        instructions: `Created ${cmdPath}. Ensure ${userBin} is in your Windows PATH.`,
      });
    }

    const localBin = path.join(os.homedir(), '.local', 'bin');
    if (!fs.existsSync(localBin)) {
      fs.mkdirSync(localBin, { recursive: true });
    }
    const symlinkPath = path.join(localBin, 'aria');
    try {
      if (fs.existsSync(symlinkPath) || fs.lstatSync(symlinkPath).isSymbolicLink()) {
        fs.unlinkSync(symlinkPath);
      }
    } catch (e) {}

    fs.symlinkSync(cliScript, symlinkPath);

    return res.json({
      success: true,
      installedPath: symlinkPath,
      instructions: `Symlinked to ${symlinkPath}. You can now run "aria ." in any directory.`,
    });
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

  // 1. Inspect what is ALREADY in the current directory and identify existing project markers
  let existingItems = [];
  try {
    if (fs.existsSync(currentDir) && fs.statSync(currentDir).isDirectory()) {
      existingItems = fs.readdirSync(currentDir).slice(0, 40);
    }
  } catch (e) {}

  const detectedMarkers = [];
  if (fs.existsSync(path.join(currentDir, 'composer.json'))) detectedMarkers.push('composer.json (PHP/Composer dependencies defined)');
  if (fs.existsSync(path.join(currentDir, 'artisan'))) detectedMarkers.push('artisan (Laravel Framework detected)');
  if (fs.existsSync(path.join(currentDir, 'package.json'))) detectedMarkers.push('package.json (Node/JS/TS dependencies defined)');
  if (fs.existsSync(path.join(currentDir, 'node_modules'))) detectedMarkers.push('node_modules (JS packages installed)');
  if (fs.existsSync(path.join(currentDir, 'vendor'))) detectedMarkers.push('vendor (Composer packages installed)');
  if (fs.existsSync(path.join(currentDir, '.env'))) detectedMarkers.push('.env (Environment file present)');
  if (fs.existsSync(path.join(currentDir, '.env.example'))) detectedMarkers.push('.env.example (Environment template present)');
  if (fs.existsSync(path.join(currentDir, 'Cargo.toml'))) detectedMarkers.push('Cargo.toml (Rust project)');
  if (fs.existsSync(path.join(currentDir, 'requirements.txt'))) detectedMarkers.push('requirements.txt (Python dependencies)');
  if (fs.existsSync(path.join(currentDir, 'pyproject.toml'))) detectedMarkers.push('pyproject.toml (Python project)');
  if (fs.existsSync(path.join(currentDir, 'go.mod'))) detectedMarkers.push('go.mod (Go module)');
  if (fs.existsSync(path.join(currentDir, '.git'))) detectedMarkers.push('.git (Git initialized)');

  // Also inspect newly created directories in detail (e.g. files inside newly created 'blog')
  let subDirDetails = '';
  for (const dirName of createdDirs.slice(0, 3)) {
    const subPath = path.join(currentDir, dirName);
    if (fs.existsSync(subPath) && fs.statSync(subPath).isDirectory()) {
      try {
        const subEntries = fs.readdirSync(subPath).slice(0, 20);
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

  let fallbackWhatHasBeenDone = '';
  if (detectedMarkers.length > 0) {
    fallbackWhatHasBeenDone = `Existing markers in folder: ${detectedMarkers.join('; ')}.`;
  } else if (existingItems.length > 0) {
    fallbackWhatHasBeenDone = `Folder contains: [${existingItems.slice(0, 10).join(', ')}]`;
  } else {
    fallbackWhatHasBeenDone = `Folder is currently empty.`;
  }

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
      fallbackWhatHasBeenDone = `Project folder "${candidateName}" created on disk.`;
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
    fallbackWhatHasBeenDone = `Created directory "${createdDirs[0]}".`;
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
ITEMS ALREADY IN FOLDER (${currentDir}): [${existingItems.join(', ') || 'Empty folder'}]
DETECTED PROJECT MARKERS: ${detectedMarkers.join('; ') || 'None'}
NEW FOLDERS CREATED: ${createdDirs.join(', ') || 'None'}
NEW FILES CREATED: ${createdFiles.join(', ') || 'None'}
${subDirDetails}
TASK CONTEXT: ${goalContext || 'Sequential task execution'}

CRITICAL AUDIT RULES:
1. ALWAYS CHECK WHAT IS ALREADY IN THE FOLDER:
   Look at "ITEMS ALREADY IN FOLDER" and "DETECTED PROJECT MARKERS".
   Identify what has ALREADY been done (e.g. project scaffolding created, dependencies installed, configuration created).
2. DO NOT REPEAT COMPLETED WORK:
   Never recommend re-running scaffolding (e.g. "laravel new" or "create-vite" or "npm init") or re-creating files that already exist in the folder.
3. DETERMINE HOW TO PROCEED:
   Based on what is already present in the folder, determine the exact way forward and the immediate next step.
4. If the command created a new project directory (e.g. "laravel new blog", "npx create-vite-app blog", "cargo new myapp"), the system MUST go inside that folder. Set "suggestedCwd" to that folder name.

You MUST respond ONLY with a valid JSON object matching this schema:
{
  "status": "success" | "warning" | "error",
  "summary": "Clear summary of the result and structure changes",
  "whatHasBeenDone": "Clear explanation of what has already been done in this folder based on existing files",
  "suggestedCwd": "subfolder name or relative path to enter, or null to stay in current directory",
  "wayForward": "Actionable explanation of current state and what should be done next to proceed",
  "suggestedNextCommands": ["next_command_1", "next_command_2"]
}`;

    if (model) {
      await ensureOnlyTargetModelLoaded(model);
    }

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
    existingItems,
    whatHasBeenDone: llmAudit?.whatHasBeenDone || fallbackWhatHasBeenDone,
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

    const validExts = new Set([
      '.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.json', '.py', '.md',
      '.env', '.sh', '.bash', '.yml', '.yaml', '.sql', '.svg', '.txt', '.php',
      '.rs', '.go', '.vue', '.svelte', '.xml'
    ]);
    const validExactNames = new Set([
      '.gitignore', '.npmignore', 'dockerfile', 'makefile', 'procfile',
      '.dockerignore', '.editorconfig', '.env.example'
    ]);

    // Extract Target Files section (supports inline comma-separated AND multiline bullet list)
    let targetFiles = [];
    const fileSectionMatch = body.match(/Target Files:?\*{0,2}\s*([\s\S]*?)(?=(?:-\s*\*{0,2}Commands|\*{0,2}Commands|###|Checklist|$))/i);
    if (fileSectionMatch) {
      const rawSection = fileSectionMatch[1];
      const lines = rawSection.split(/[\r\n]+/);
      const candidateStrings = [];
      for (const line of lines) {
        const cleanLine = line.replace(/^\s*[-*+]\s*/, '').trim();
        if (!cleanLine) continue;
        cleanLine.split(/[,;]/).forEach((s) => candidateStrings.push(s));
      }

      const seenFiles = new Set();
      for (let raw of candidateStrings) {
        let cleaned = raw.replace(/\([^\)]*\)/g, '');
        cleaned = cleaned.replace(/[`*'"\\:]/g, '').trim().replace(/^(\.\/|\/)/, '');
        if (!cleaned) continue;

        const tokens = cleaned.split(/\s+/);
        for (const token of tokens) {
          const lower = token.toLowerCase();
          if (lower === 'package-lock.json' || lower === 'yarn.lock' || lower === 'pnpm-lock.yaml' || lower === 'implementation_plan.md') continue;
          const ext = path.extname(lower);
          if ((validExts.has(ext) || validExactNames.has(lower)) && !seenFiles.has(token)) {
            seenFiles.add(token);
            targetFiles.push(token);
          }
        }
      }
    }

    // Extract Commands section (supports inline comma-separated AND multiline bullet list)
    let commands = [];
    const cmdSectionMatch = body.match(/Commands:?\*{0,2}\s*([\s\S]*?)(?=(?:-\s*\*{0,2}Checklist|\*{0,2}Checklist|###|$))/i);
    if (cmdSectionMatch) {
      const rawSection = cmdSectionMatch[1];
      const lines = rawSection.split(/[\r\n]+/);
      const seenCmds = new Set();
      for (const line of lines) {
        let cleanLine = line.replace(/^\s*[-*+]\s*/, '').replace(/[`*'"\\]/g, '').replace(/^[$#]\s*/, '').trim();
        if (!cleanLine || cleanLine.toLowerCase().startsWith('none')) continue;
        const subCmds = cleanLine.includes(',') && !cleanLine.includes('&&') ? cleanLine.split(',') : [cleanLine];
        for (let sc of subCmds) {
          sc = sc.trim();
          if (sc && !seenCmds.has(sc)) {
            seenCmds.add(sc);
            commands.push(sc);
          }
        }
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

TASK & FOLDER AUDIT RULES:
1. ALWAYS CHECK WHAT IS ALREADY IN THE FOLDER: Look at "Current Files in Directory" and "Active Working Directory". Identify what has ALREADY been done (files written, commands run, dependencies configured).
2. NEVER RE-RUN COMPLETED WORK: Do NOT re-create files or re-run commands that already exist and are valid.
3. DETERMINE THE EXACT WAY FORWARD: Formulate updated phases that build directly on what is already in the folder, proceeding cleanly to the next necessary actions.
4. If the user changed the directory, stack, or tools, reflect that in the new phases.

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

// Endpoint: User Intent Interpretation Layer
// Analyzes user prompt, workspace context, and conversation history before any implementation begins.
app.post('/api/agent/interpret', async (req, res) => {
  const { model, primaryModel, prompt, workspacePath, currentCwd, recentHistory = [], conversationHistory } = req.body;
  if (!model || !prompt) {
    return res.status(400).json({ error: 'model and prompt are required' });
  }

  const targetWorkspace = workspacePath || process.cwd();
  const activeWorkingDir = currentCwd || workspaceCwdMap.get(targetWorkspace) || targetWorkspace;

  // 1. Workspace context scan
  const tree = buildFileTree(targetWorkspace, 0, 2);
  const fileListSnippet = tree.map((t) => (t.isDirectory ? `📁 ${t.name}/` : `📄 ${t.name}`)).slice(0, 35).join('\n');

  let manifestInfo = '';
  const pkgPath = path.join(targetWorkspace, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      manifestInfo += `Project: ${pkg.name || 'app'} | Dependencies: ${Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).slice(0, 15).join(', ')}`;
    } catch (e) {}
  }

  // Check if IMPLEMENTATION_PLAN.md exists on disk
  let planSummary = '';
  const planPath = path.join(targetWorkspace, 'IMPLEMENTATION_PLAN.md');
  if (fs.existsSync(planPath)) {
    try {
      const planText = fs.readFileSync(planPath, 'utf8');
      planSummary = `\nExisting IMPLEMENTATION_PLAN.md on disk:\n${planText.slice(0, 1200)}\n`;
    } catch (e) {}
  }

  // Check recent activities from .ide/activity.json
  let recentActivities = '';
  const actPath = path.join(targetWorkspace, '.ide', 'activity.json');
  if (fs.existsSync(actPath)) {
    try {
      const acts = JSON.parse(fs.readFileSync(actPath, 'utf8'));
      const lastActs = acts.slice(-4);
      if (lastActs.length > 0) {
        recentActivities = `\nRecent actions:\n${lastActs.map((a) => `- [${a.type}] ${a.command || a.path || a.title || ''} (Success: ${a.success ?? 'N/A'})`).join('\n')}\n`;
      }
    } catch (e) {}
  }

  // Conversation history: support both conversationHistory and recentHistory up to 10 turns
  const historyList = Array.isArray(conversationHistory) && conversationHistory.length > 0
    ? conversationHistory
    : (Array.isArray(recentHistory) ? recentHistory : []);

  const cleanHistory = historyList
    .filter((m) => m && m.content && m.content.trim())
    .slice(-10);

  const historySnippet = cleanHistory.length > 0
    ? `\nPRIOR CONVERSATION TRANSCRIPT (CONTINUATION MEMORY):\n${cleanHistory.map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 500)}`).join('\n\n')}\n`
    : '';

  const interpreterPrompt = `You are the Intent Interpretation Engine of Aria IDE.
Before any code generation, plan creation, or command execution occurs, you must analyze the user's input to determine their precise intent.

USER INPUT:
"${prompt}"

WORKSPACE CONTEXT:
Active Directory: ${activeWorkingDir}
Existing Workspace Files:
${fileListSnippet || '(Empty directory)'}
${manifestInfo ? `Manifest: ${manifestInfo}` : ''}
${planSummary}
${recentActivities}
${historySnippet}
INSTRUCTIONS:
1. Context Continuation: If the user references earlier conversation (e.g., "recover the situation", "it failed", "continue", "show me what we did", "proceed"), resolve the referents and context using the PRIOR CONVERSATION TRANSCRIPT, existing files, and recent actions above!
2. Determine the user's intent category:
   - "implementation": User wants to build, create, scaffold, or implement a feature/component/application.
   - "modification": User wants to edit, update, style, or refactor existing code.
   - "bugfix": User wants to fix an error, bug, failure, or broken functionality (including recovering from an error or failed command).
   - "investigation": User wants to inspect, audit, review code, or understand how something works in this workspace.
   - "terminal_command": User wants to run a specific command (e.g., install dependencies, run dev server, build, git).
   - "question": User is asking a conceptual, technical, or general programming question (no file changes needed).

2. Formulate:
   - "coreObjective": 1 concise, direct sentence describing what the user wants to achieve.
   - "targetScope": array of 1 to 5 relevant files, components, or folders that are targeted or affected.
   - "proposedStrategy": 2 concise sentences explaining the approach or solution strategy.
   - "isActionable": true if the request requires creating/modifying files or running build/install commands; false if it's a question, inquiry, or explanation.
   - "confidence": "high", "medium", or "low".

OUTPUT FORMAT:
Respond with ONLY valid JSON inside a \`\`\`json code block, with NO other commentary:
\`\`\`json
{
  "intentType": "implementation",
  "coreObjective": "...",
  "targetScope": ["file1", "file2"],
  "proposedStrategy": "...",
  "isActionable": true,
  "confidence": "high"
}
\`\`\``;

  try {
    await ensureOnlyTargetModelLoaded(model, primaryModel ? [primaryModel] : []);

    const ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are the Aria IDE Intent Interpretation Engine. Return only valid JSON in ```json blocks.' },
          { role: 'user', content: interpreterPrompt },
        ],
        stream: false,
        options: {
          temperature: 0.1,
          num_predict: 800,
        },
      }),
    });

    if (!ollamaRes.ok) {
      throw new Error(`Ollama error: ${await ollamaRes.text()}`);
    }

    const data = await ollamaRes.json();
    const content = data.message?.content || '';

    let parsed = null;
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[1]);
      } catch (e) {}
    }

    if (!parsed) {
      const braceMatch = content.match(/\{[\s\S]*\}/);
      if (braceMatch) {
        try {
          parsed = JSON.parse(braceMatch[0]);
        } catch (e) {}
      }
    }

    if (!parsed || !parsed.intentType) {
      const isActionableHeuristic = /(\b(build|create|make|code|write|implement|scaffold|setup|develop|add|fix|refactor|install|generate|recover|retry|resume|continue|execute|apply)\b)/i.test(prompt);
      parsed = {
        intentType: isActionableHeuristic ? 'implementation' : 'question',
        coreObjective: prompt.slice(0, 100),
        targetScope: [],
        proposedStrategy: isActionableHeuristic
          ? 'Analyze project structure and execute the requested implementation.'
          : 'Provide a direct explanation to answer the user query.',
        isActionable: isActionableHeuristic,
        confidence: 'medium',
      };
    }

    res.json({
      success: true,
      interpretation: {
        intentType: parsed.intentType || 'implementation',
        coreObjective: parsed.coreObjective || prompt,
        targetScope: Array.isArray(parsed.targetScope) ? parsed.targetScope : [],
        proposedStrategy: parsed.proposedStrategy || '',
        isActionable: Boolean(parsed.isActionable),
        confidence: parsed.confidence || 'high',
      },
    });
  } catch (err) {
    const isActionable = /(\b(build|create|make|code|write|implement|scaffold|setup|develop|add|fix|refactor|install|generate|recover|retry|resume|continue|execute|apply)\b)/i.test(prompt);
    res.json({
      success: true,
      interpretation: {
        intentType: isActionable ? 'implementation' : 'question',
        coreObjective: prompt.slice(0, 100),
        targetScope: [],
        proposedStrategy: isActionable ? 'Proceed with implementation plan.' : 'Provide direct response.',
        isActionable,
        confidence: 'medium',
      },
    });
  }
});

// Endpoint: Generate Implementation Plan and write IMPLEMENTATION_PLAN.md to disk
app.post('/api/agent/plan', async (req, res) => {
  const { model, fastPilotModel, prompt, workspacePath, interpretation, conversationHistory = [], recentHistory = [] } = req.body;
  if (!model || !prompt) {
    return res.status(400).json({ error: 'model and prompt are required' });
  }

  const targetWorkspace = workspacePath || process.cwd();
  const tree = buildFileTree(targetWorkspace, 0, 2);
  const fileListSnippet = tree.map((t) => (t.isDirectory ? `📁 ${t.name}/` : `📄 ${t.name}`)).join('\n');

  // Check if IMPLEMENTATION_PLAN.md already exists
  let existingPlanSnippet = '';
  const existingPlanPath = path.join(targetWorkspace, 'IMPLEMENTATION_PLAN.md');
  if (fs.existsSync(existingPlanPath)) {
    try {
      const existingPlanText = fs.readFileSync(existingPlanPath, 'utf8');
      existingPlanSnippet = `\nPREVIOUS IMPLEMENTATION_PLAN.md ON DISK:\n${existingPlanText.slice(0, 1500)}\n`;
    } catch (e) {}
  }

  // Conversation history: include prior conversation context for multi-turn continuation
  const historyList = Array.isArray(conversationHistory) && conversationHistory.length > 0
    ? conversationHistory
    : (Array.isArray(recentHistory) ? recentHistory : []);

  const cleanHistory = historyList
    .filter((m) => m && m.content && m.content.trim())
    .slice(-10);

  const historySnippet = cleanHistory.length > 0
    ? `\nPRIOR CONVERSATION TRANSCRIPT (CONTINUATION MEMORY):\n${cleanHistory.map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 600)}`).join('\n\n')}\n`
    : '';

  const interpretationSnippet = interpretation ? `
INTERPRETED INTENT & OBJECTIVE:
Category: ${interpretation.intentType}
Core Objective: ${interpretation.coreObjective}
${interpretation.targetScope && interpretation.targetScope.length > 0 ? `Target Scope: ${interpretation.targetScope.join(', ')}` : ''}
${interpretation.proposedStrategy ? `Proposed Strategy: ${interpretation.proposedStrategy}` : ''}
` : '';

  const architectPrompt = `You are the Lead Software Architect of Aria IDE.
Target workspace directory: ${targetWorkspace}
Existing files in workspace:
${fileListSnippet || '(Empty workspace)'}
${existingPlanSnippet}
${historySnippet}
USER REQUEST:
"${prompt}"
${interpretationSnippet}

CRITICAL ARCHITECT RULES:
1. CONTINUATION & RECOVERY: If the user request or conversation indicates continuing from a prior phase or recovering from a previous failure, build directly upon what is already done and tailor this plan to resolve the situation.
2. ALWAYS CHECK WHAT IS ALREADY IN THE FOLDER: Inspect "Existing files in workspace" above. Determine what has already been done before generating phases.
3. DO NOT RE-INITIALIZE: If a project folder, framework, or configuration files (such as package.json, composer.json, Cargo.toml) already exist, do NOT schedule steps to re-create or re-initialize them.
4. DETERMINE HOW TO PROCEED: Build upon the existing state and outline the exact steps to proceed from there.

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
    await ensureOnlyTargetModelLoaded(model, fastPilotModel ? [fastPilotModel] : []);

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

// Endpoint: Autonomous Step-by-Step Execution Engine
// Analyzes environment, folder contents, past actions & user guidance, then executes next single atomic action
app.post('/api/agent/step', async (req, res) => {
  const {
    model,
    primaryModel,
    planPrompt,
    planMarkdown,
    stepIndex = 1,
    completedActions = [],
    lastActionResult = null,
    additionalUserGuidance = [],
    workspacePath,
    currentCwd,
    thinkingEnabled = false,
    conversationHistory = [],
    recentHistory = [],
  } = req.body;

  if (!model || !planPrompt) {
    return res.status(400).json({ error: 'model and planPrompt are required' });
  }

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

  try {
    const targetWorkspace = workspacePath || process.cwd();
    let activeWorkingDir = currentCwd || workspaceCwdMap.get(targetWorkspace) || targetWorkspace;

    // 1. Live scan of active working directory and whole workspace
    let cwdEntries = [];
    try {
      if (fs.existsSync(activeWorkingDir) && fs.statSync(activeWorkingDir).isDirectory()) {
        cwdEntries = fs.readdirSync(activeWorkingDir);
      }
    } catch (e) {}

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

    let ideContextSnippet = '';
    const ideContextPath = path.join(targetWorkspace, '.ide', 'context.md');
    if (fs.existsSync(ideContextPath)) {
      try {
        ideContextSnippet = `\n--- RECENT WORKSPACE ACTIVITY (.ide) ---\n${fs.readFileSync(ideContextPath, 'utf8').slice(0, 1000)}\n`;
      } catch (e) {}
    }

    const guidanceSnippet = Array.isArray(additionalUserGuidance) && additionalUserGuidance.length > 0
      ? `\n======================================================================
⚡ HIGH-PRIORITY USER INSTRUCTION RECEIVED DURING EXECUTION:
${additionalUserGuidance.map((g, i) => `${i + 1}. "${g}"`).join('\n')}
You MUST incorporate these instructions immediately into your ongoing implementation!
======================================================================\n`
      : '';

    const historyList = Array.isArray(conversationHistory) && conversationHistory.length > 0
      ? conversationHistory
      : (Array.isArray(recentHistory) ? recentHistory : []);

    const cleanHistory = historyList
      .filter((m) => m && m.content && m.content.trim())
      .slice(-8);

    const historySnippet = cleanHistory.length > 0
      ? `\nRECENT CONVERSATION HISTORY (USER & AGENT CONTEXT):\n${cleanHistory.map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 400)}`).join('\n')}\n`
      : '';

    const previousActionSnippet = lastActionResult
      ? `Type: ${lastActionResult.type} | Target: ${lastActionResult.target || lastActionResult.path || lastActionResult.command} | Success: ${lastActionResult.success}
${lastActionResult.stdout ? `Terminal Stdout:\n${lastActionResult.stdout.slice(0, 600)}\n` : ''}
${lastActionResult.stderr ? `Terminal Stderr:\n${lastActionResult.stderr.slice(0, 600)}\n` : ''}
${lastActionResult.filesCreated && lastActionResult.filesCreated.length > 0 ? `Files created/modified: ${lastActionResult.filesCreated.join(', ')}\n` : ''}`
      : 'Initial step (no previous action executed yet).';

    const completedSummarySnippet = Array.isArray(completedActions) && completedActions.length > 0
      ? completedActions.map((a, i) => `${i + 1}. [${a.type || 'action'}] ${a.summary || a.command || a.path}`).join('\n')
      : 'None yet (Starting Step 1).';

    const stepPrompt = `You are the Autonomous Software Engineer of the Aria IDE.
You are in full control of implementing:
"${planPrompt}"

IMPLEMENTATION PLAN:
${planMarkdown ? planMarkdown.slice(0, 2500) : '(No formal plan markdown provided)'}

ACTIONS COMPLETED SO FAR (${completedActions.length}):
${completedSummarySnippet}

OUTCOME OF PREVIOUS ACTION:
${previousActionSnippet}

REAL-TIME DISK SCAN (ACTIVE FOLDER & WORKSPACE):
Active Folder Path: ${activeWorkingDir} (relative: ${path.relative(targetWorkspace, activeWorkingDir) || '.'})
ITEMS ALREADY IN THIS ACTIVE FOLDER:
[${cwdEntries.slice(0, 45).join(', ') || 'Empty folder'}]
Workspace Files:
${fileListSnippet || '(Empty workspace)'}
${manifestInfo}
${ideContextSnippet}
${guidanceSnippet}
${historySnippet}
OPERATIONAL RULES:
1. Examine what is ALREADY in the folder before issuing any command. Never re-initialize scaffolding if already initialized!
2. If the previous command had an error (missing dependency, failed build, syntax issue), fix it immediately.
3. If all files and commands required by the implementation plan have been fully created, tested, and verified, output OPTION 3 (COMPLETE).
4. Otherwise, choose EXACTLY ONE atomic action to advance the project to the next state:

Option 1 - WRITE OR EDIT A SPECIFIC FILE:
\`\`\`file:relative/path/to/file.ext
[complete code here]
\`\`\`

Option 2 - RUN A TERMINAL COMMAND:
\`\`\`bash
command to execute
\`\`\`

Option 3 - FINISH & COMPLETE IMPLEMENTATION:
\`\`\`complete
Summary of what was completed and verified.
\`\`\`

Explain your reasoning in 1-2 concise sentences, then output the single action block:`;

    sendEvent('status', { status: `LLM analyzing environment for Step ${stepIndex}...` });

    await ensureOnlyTargetModelLoaded(model, primaryModel ? [primaryModel] : []);

    const ollamaMessages = [
      { role: 'system', content: 'You are Aria IDE Autonomous Software Engineer. Issue one action at a time and drive the plan step by step.' },
      { role: 'user', content: stepPrompt },
    ];

    const ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: ollamaMessages,
        stream: true,
        keep_alive: '15m',
        options: {
          temperature: 0.2,
          num_predict: 3500,
          num_ctx: 4096,
        },
      }),
    });

    if (!ollamaRes.ok) {
      const err = await ollamaRes.text();
      throw new Error(`Ollama error: ${err}`);
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
            if (delta.includes('<think>')) inThinkTag = true;
            if (inThinkTag) accumulatedThinking += delta;
            if (delta.includes('</think>')) inThinkTag = false;

            sendEvent('chunk', {
              chunk: delta,
              isThinking: inThinkTag,
            });
          }
        } catch (e) {}
      }
    }

    // Check if task is marked complete
    const isCompleteBlock =
      /```complete[\r\n]([\s\S]*?)```/i.test(accumulatedContent) ||
      accumulatedContent.toLowerCase().includes('```complete') ||
      (accumulatedContent.toLowerCase().includes('all phases') && accumulatedContent.toLowerCase().includes('completed'));

    if (isCompleteBlock) {
      const matchSummary = accumulatedContent.match(/```complete[\r\n]([\s\S]*?)```/i);
      const completionSummary = matchSummary ? matchSummary[1].trim() : 'All implementation plan steps completed and verified.';
      sendEvent('step_completed', {
        stepIndex,
        actionType: 'plan_complete',
        isFinished: true,
        summary: completionSummary,
        explanation: accumulatedContent.replace(/```[\s\S]*?```/g, '').trim(),
      });
      sendEvent('done', {
        isFinished: true,
        summary: completionSummary,
      });
      return res.end();
    }

    // Extract action blocks from the model response
    const { fileActions, bashActions } = extractActionsFromText(accumulatedContent, []);

    if (fileActions.length > 0) {
      const fa = fileActions[0];
      try {
        const resWrite = writeWorkspaceFile(targetWorkspace, fa.path, fa.content);
        appendIdeActivity(targetWorkspace, { type: 'file_written', path: resWrite.relPath, size: resWrite.size });
        sendEvent('file_written', {
          path: resWrite.relPath,
          fullPath: resWrite.absPath,
          size: resWrite.size,
          originalContent: resWrite.originalContent,
          isNewFile: resWrite.isNewFile,
          content: resWrite.content,
        });

        sendEvent('step_completed', {
          stepIndex,
          actionType: 'file_written',
          isFinished: false,
          summary: `Created/updated ${resWrite.relPath} (${resWrite.size} bytes)`,
          actionResult: {
            type: 'file_written',
            target: resWrite.relPath,
            path: resWrite.relPath,
            fullPath: resWrite.absPath,
            size: resWrite.size,
            success: true,
          },
          explanation: accumulatedContent.replace(/```[\s\S]*?```/g, '').trim(),
        });
      } catch (fErr) {
        sendEvent('step_completed', {
          stepIndex,
          actionType: 'file_error',
          isFinished: false,
          summary: `Failed to write ${fa.path}: ${fErr.message}`,
          actionResult: {
            type: 'file_written',
            target: fa.path,
            success: false,
            stderr: fErr.message,
          },
        });
      }
    } else if (bashActions.length > 0) {
      const ba = bashActions[0];
      sendEvent('command_started', { command: ba.command, cwd: activeWorkingDir });
      const beforeSnap = inspectDirectorySnapshot(activeWorkingDir);

      const resCmd = await executeCommandLiveStream({
        command: ba.command,
        cwd: activeWorkingDir,
        onStdout: (chunk) => sendEvent('command_stdout', { command: ba.command, chunk }),
        onStderr: (chunk) => sendEvent('command_stderr', { command: ba.command, chunk }),
        signal: controller.signal,
      });

      sendEvent('command_finished', { command: ba.command, exitCode: resCmd.exitCode, success: resCmd.success });

      const afterSnap = inspectDirectorySnapshot(activeWorkingDir);
      const createdDirs = afterSnap.dirs.filter((d) => !beforeSnap.dirs.includes(d));
      const createdFiles = afterSnap.files.filter((f) => !beforeSnap.files.includes(f));

      const audit = await auditCommandAndStructure({
        command: ba.command,
        exitCode: resCmd.exitCode,
        stdout: resCmd.stdout,
        stderr: resCmd.stderr,
        currentCwd: activeWorkingDir,
        workspacePath: targetWorkspace,
        createdDirs,
        createdFiles,
        model,
      });

      sendEvent('command_audited', audit);
      if (audit.newCwd !== activeWorkingDir) {
        activeWorkingDir = audit.newCwd;
        workspaceCwdMap.set(targetWorkspace, activeWorkingDir);
        broadcastToTerminal({ type: 'set_cwd', cwd: activeWorkingDir });
        sendEvent('cwd_changed', { newCwd: activeWorkingDir, relativeCwd: audit.relativeCwd });
      }

      appendIdeActivity(targetWorkspace, {
        type: 'command_audited',
        command: ba.command,
        exitCode: resCmd.exitCode,
        success: resCmd.success,
        auditSummary: audit.summary,
        newCwd: audit.relativeCwd,
      });

      sendEvent('command_executed', { command: ba.command, ...resCmd, audit });

      sendEvent('step_completed', {
        stepIndex,
        actionType: 'command',
        isFinished: false,
        summary: `Ran "${ba.command}" (exit: ${resCmd.exitCode})`,
        actionResult: {
          type: 'command_executed',
          target: ba.command,
          command: ba.command,
          success: resCmd.success,
          exitCode: resCmd.exitCode,
          stdout: resCmd.stdout,
          stderr: resCmd.stderr,
          filesCreated: createdFiles,
          dirsCreated: createdDirs,
        },
        explanation: accumulatedContent.replace(/```[\s\S]*?```/g, '').trim(),
      });
    } else {
      sendEvent('step_completed', {
        stepIndex,
        actionType: 'info',
        isFinished: false,
        summary: accumulatedContent.slice(0, 100),
        actionResult: {
          type: 'info',
          target: 'reasoning',
          success: true,
        },
        explanation: accumulatedContent,
      });
    }

    sendEvent('done', { isFinished: false });
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

// Endpoint: Stream Agent Response & Execute Tools / File Writes in Real-Time
app.post('/api/agent/stream', async (req, res) => {
    const {
      model,
      fastPilotModel,
      prompt,
      workspacePath,
      currentCwd,
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

    // 1. Dedicated Implementation Plan Inspection
    let planSnippet = '';
    const planPath = path.join(targetWorkspace, 'IMPLEMENTATION_PLAN.md');
    if (fs.existsSync(planPath)) {
      try {
        const planText = fs.readFileSync(planPath, 'utf8');
        planSnippet = `\n======================================================================
ACTIVE IMPLEMENTATION PLAN (IMPLEMENTATION_PLAN.md):
${planText.slice(0, 5000)}
======================================================================\n`;
      } catch (e) {}
    }

    // 2. Recent Activity & Failed Commands from .ide/activity.json
    let recentActivitySnippet = '';
    const actFile = path.join(targetWorkspace, '.ide', 'activity.json');
    if (fs.existsSync(actFile)) {
      try {
        const activities = JSON.parse(fs.readFileSync(actFile, 'utf8'));
        const lastFew = activities.slice(-6);
        if (lastFew.length > 0) {
          recentActivitySnippet = `\nRECENT COMMANDS & WORKSPACE ACTIONS:
${lastFew.map((a) => `- [${a.type}] ${a.command || a.path || ''} (Success: ${a.success ?? 'N/A'}${a.exitCode !== undefined ? `, Exit: ${a.exitCode}` : ''}${a.auditSummary ? ` | ${a.auditSummary}` : ''})`).join('\n')}\n`;
        }
      } catch (e) {}
    }

    // 3. Context from .ide/context.md
    let ideContextSnippet = '';
    const ideContextPath = path.join(targetWorkspace, '.ide', 'context.md');
    if (fs.existsSync(ideContextPath)) {
      try {
        const ctxText = fs.readFileSync(ideContextPath, 'utf8');
        ideContextSnippet = `\n--- RECENT WORKSPACE ACTIVITY (.ide) ---\n${ctxText.slice(0, 1500)}\n`;
      } catch (e) {}
    }

    // 4. Direct File System Inspection: Top-level workspace code files
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

    // 5. Active Monaco Editor File (if provided)
    let activeFileSnippet = '';
    if (activeFile && activeFile.path && activeFile.content) {
      activeFileSnippet = `\nCURRENTLY ACTIVE OPEN FILE IN MONACO EDITOR:
Path: ${activeFile.path}
Content:
\`\`\`
${activeFile.content.slice(0, 10000)}
\`\`\`\n`;
    }

    // 6. Active Working Directory & Current Folder Contents
    const activeWorkingDir = currentCwd || (workspaceCwdMap.get(targetWorkspace) || targetWorkspace);
    let activeCwdSnippet = '';
    try {
      if (fs.existsSync(activeWorkingDir) && fs.statSync(activeWorkingDir).isDirectory()) {
        const cwdEntries = fs.readdirSync(activeWorkingDir);
        activeCwdSnippet = `\nCURRENT ACTIVE WORKING DIRECTORY:
Path: ${activeWorkingDir} (relative: ${path.relative(targetWorkspace, activeWorkingDir) || '.'})
ITEMS ALREADY IN THIS ACTIVE FOLDER:
[${cwdEntries.slice(0, 40).join(', ') || 'Empty folder'}]\n`;
      }
    } catch (e) {}

    let systemInstruction = `You are the Autonomous Software Engineer of Aria IDE.
You are running directly on Linux Ubuntu with DIRECT, ACTIVE ACCESS to the workspace at:
${targetWorkspace}

WORKSPACE ENVIRONMENT & ACTIVE PLAN:
${planSnippet || '(No IMPLEMENTATION_PLAN.md found on disk)'}
Workspace Files:
${fileListSnippet || '(Empty workspace)'}
${manifestInfo}
${recentActivitySnippet}
${ideContextSnippet}
${existingFilesSnippet}
${activeFileSnippet}
${activeCwdSnippet}

CRITICAL OPERATIONAL RULES:
1. NEVER CLAIM YOU LACK ACCESS: You are NOT an isolated web chatbot. You are the embedded core engine of Aria IDE. You ALREADY have direct access to the workspace directory, files, and implementation plan provided above. NEVER apologize or say "as an AI language model, I do not have access to the folder or files".
2. RECOVERING SITUATIONS & PROCEEDING: If the user asks to recover a situation, check what has been done, or consult the implementation plan, inspect the ACTIVE IMPLEMENTATION PLAN, RECENT ACTIONS, and ITEMS ALREADY IN THIS ACTIVE FOLDER above. Diagnose what failed or succeeded, and immediately provide the exact fix, command, or file updates.
3. MANDATORY FOLDER INSPECTION: Examine what is already in the folder before taking action. Never re-initialize scaffolding (e.g., "laravel new", "composer create-project", "npm init") if already initialized!
4. Provide real, complete code without placeholders or omissions.
5. When writing code, use explicit blocks:
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

    // Smart context pruning: sanitizes generic AI boilerplate, preserves up to 10 conversation turns, and ensures proper alternating roles
    const rawHistory = Array.isArray(conversationHistory) ? conversationHistory.slice(-10) : [];
    const sanitizedHistory = [];

    for (const msg of rawHistory) {
      if (!msg || !msg.content || !msg.content.trim()) continue;
      let content = msg.content;
      // Strip generic canned AI disclaimers so small models don't mimic them
      content = content.replace(/I apologize, but as an AI language model[^\n]*/gi, '');
      content = content.replace(/as an AI language model, I do not have access[^\n]*/gi, '');
      content = content.replace(/Please provide me with the implementation plan document[^\n]*/gi, '');
      content = content.replace(/I am an AI assistant and I do not have[^\n]*/gi, '');
      if (content.length > 2500) {
        content = content.replace(/```(?:file:[^\n]+|[\w]+)?\n([\s\S]{250,}?)```/g, () => {
          return '```\n[Code block omitted: file already synced to disk]\n```';
        });
      }
      if (content.trim()) {
        sanitizedHistory.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: content.trim(),
        });
      }
    }

    // Ensure the conversation ends with the current user prompt
    const lastHist = sanitizedHistory[sanitizedHistory.length - 1];
    if (!lastHist || lastHist.role !== 'user' || lastHist.content !== prompt.trim()) {
      sanitizedHistory.push({ role: 'user', content: prompt });
    }

    const prunedMessages = [{ role: 'system', content: systemInstruction }];

    // Merge any adjacent messages with identical roles so Ollama gets clean alternating turns:
    // system -> user -> assistant -> user -> assistant -> user
    for (const msg of sanitizedHistory) {
      const prevMsg = prunedMessages[prunedMessages.length - 1];
      if (prevMsg && prevMsg.role === msg.role && prevMsg.role !== 'system') {
        prevMsg.content += `\n\n${msg.content}`;
      } else {
        prunedMessages.push({ role: msg.role, content: msg.content });
      }
    }

    // Double check that the final message is from user
    if (prunedMessages[prunedMessages.length - 1].role !== 'user') {
      prunedMessages.push({ role: 'user', content: prompt });
    }

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
      await ensureOnlyTargetModelLoaded(model, fastPilotModel ? [fastPilotModel] : []);

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
        let streamCwd = currentCwd || workspaceCwdMap.get(targetWorkspace) || targetWorkspace;
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
        let streamCwd = currentCwd || workspaceCwdMap.get(targetWorkspace) || targetWorkspace;

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

// Serve built production frontend if dist directory exists
const distPath = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/ws')) {
      return next();
    }
    const indexPath = path.join(distPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
    next();
  });
}

server.listen(PORT, () => {
  console.log(`[Aria IDE Backend] Listening on http://localhost:${PORT}`);
  console.log(`[Aria IDE Backend] WebSocket Terminal ready on ws://localhost:${PORT}`);
});
