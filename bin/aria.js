#!/usr/bin/env node

/**
 * Aria IDE - Terminal CLI Launcher
 * Usage:
 *   aria .                  Launch Aria IDE with current directory
 *   aria /path/to/project   Launch Aria IDE with specified directory
 *   aria --install-cli      Install 'aria' command into system PATH (~/.local/bin or /usr/local/bin)
 *   aria --status           Check Aria server and active Ollama models
 *   aria --web              Force open in default web browser
 *   aria --version          Display version
 *   aria --help             Show help
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
import http from 'node:http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const VERSION = '0.1.0';
const DEFAULT_PORT = 3001;
const VITE_PORT = 5173;

// Parse CLI Arguments
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  console.log(`Aria IDE CLI v${VERSION}`);
  process.exit(0);
}

if (args.includes('--install-cli') || args.includes('--install')) {
  installToPath();
  process.exit(0);
}

if (args.includes('--status')) {
  checkStatus();
} else {
  launchAria();
}

function printHelp() {
  console.log(`
\x1b[1m\x1b[36mARIA IDE CLI\x1b[0m - Open-Source Autonomous AI Development Environment
Powered by local, self-hosted LLMs with intelligent structure awareness.

\x1b[1mUSAGE:\x1b[0m
  \x1b[32maria [path]\x1b[0m             Open the specified directory in Aria IDE (defaults to '.')
  \x1b[32maria .\x1b[0m                  Open current folder in Aria IDE
  \x1b[32maria ~/my-project\x1b[0m       Open target project path in Aria IDE

\x1b[1mOPTIONS:\x1b[0m
  \x1b[33m--install-cli\x1b[0m           Install the 'aria' command into your user's system PATH
  \x1b[33m--status\x1b[0m                Check Aria IDE background server & loaded Ollama models
  \x1b[33m--web\x1b[0m                   Force opening in default web browser
  \x1b[33m--port <number>\x1b[0m         Specify custom backend port (default: 3001)
  \x1b[33m-v, --version\x1b[0m           Print version number
  \x1b[33m-h, --help\x1b[0m              Show this help message

\x1b[1mEXAMPLES:\x1b[0m
  $ cd ~/projects/laravel-app
  $ aria .
  $ aria /home/user/workspace/vite-react
`);
}

/**
 * Installs 'aria' binary into ~/.local/bin or /usr/local/bin on Linux/macOS,
 * or %USERPROFILE%\bin on Windows.
 */
function installToPath() {
  console.log('\x1b[36m[Aria IDE CLI]\x1b[0m Installing "aria" command into your PATH...');
  const isWindows = process.platform === 'win32';
  const cliScript = path.resolve(__dirname, 'aria.js');

  try {
    fs.chmodSync(cliScript, 0o755);
  } catch (e) {}

  if (isWindows) {
    const userBin = path.join(os.homedir(), 'bin');
    if (!fs.existsSync(userBin)) {
      fs.mkdirSync(userBin, { recursive: true });
    }
    const cmdPath = path.join(userBin, 'aria.cmd');
    const cmdContent = `@echo off\r\nnode "${cliScript}" %*\r\n`;
    fs.writeFileSync(cmdPath, cmdContent, 'utf8');

    console.log(`\x1b[32m✓ Created Windows launcher at:\x1b[0m ${cmdPath}`);
    console.log(`\x1b[33mNote:\x1b[0m Ensure "${userBin}" is included in your system/user PATH environment variable.`);
    return;
  }

  // Linux / macOS: Prefer ~/.local/bin (no sudo required)
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

  try {
    fs.symlinkSync(cliScript, symlinkPath);
    console.log(`\x1b[32m✓ Successfully linked "aria" command to:\x1b[0m ${symlinkPath}`);
    console.log(`\x1b[1mYou can now run \x1b[32maria .\x1b[0m in any folder!\x1b[0m`);
  } catch (err) {
    console.error(`\x1b[31mFailed to create symlink at ${symlinkPath}:\x1b[0m ${err.message}`);
    console.log(`\x1b[33mTry running:\x1b[0m sudo ln -sf "${cliScript}" /usr/local/bin/aria`);
  }
}

/**
 * Checks server status and loaded models in memory
 */
async function checkStatus() {
  console.log('\x1b[36m[Aria IDE CLI]\x1b[0m Checking Aria server status on port 3001...');
  try {
    const res = await fetchJson('http://localhost:3001/api/models/active');
    console.log('\x1b[32m✓ Aria Server is running!\x1b[0m');
    console.log(`System RAM: ${res.systemMemory?.totalGB || 'N/A'} GB Total | ${res.systemMemory?.availableGB || 'N/A'} GB Free`);
    if (Array.isArray(res.activeModels) && res.activeModels.length > 0) {
      console.log(`\x1b[33mLoaded Models in RAM (${res.activeModels.length}):\x1b[0m`);
      for (const m of res.activeModels) {
        console.log(`  - ${m.name} (${m.ramGB || m.sizeGB} GB RAM)`);
      }
    } else {
      console.log('\x1b[32m✓ RAM is completely clean (0 models loaded in memory).\x1b[0m');
    }
  } catch (err) {
    console.log('\x1b[33mAria IDE backend is currently not running.\x1b[0m');
    console.log('Run \x1b[32maria .\x1b[0m in any project directory to launch it!');
  }
}

/**
 * Launch Aria IDE pointing to target directory
 */
async function launchAria() {
  // Extract target folder (first argument that doesn't start with -)
  const targetArg = args.find((a) => !a.startsWith('-')) || '.';
  const targetDir = path.resolve(process.cwd(), targetArg);

  if (!fs.existsSync(targetDir)) {
    console.error(`\x1b[31mError:\x1b[0m Directory "${targetDir}" does not exist.`);
    process.exit(1);
  }

  const stat = fs.statSync(targetDir);
  if (!stat.isDirectory()) {
    console.error(`\x1b[31mError:\x1b[0m "${targetDir}" is a file, not a directory. Please provide a directory path.`);
    process.exit(1);
  }

  console.log(`\x1b[1m\x1b[36m[Aria IDE]\x1b[0m Opening workspace: \x1b[32m${targetDir}\x1b[0m`);

  // 1. Check if backend server is already running on port 3001
  const isServerRunning = await pingServer(DEFAULT_PORT);

  if (!isServerRunning) {
    console.log('\x1b[36m[Aria IDE]\x1b[0m Starting Aria background server...');
    startBackgroundServer(targetDir);
    // Wait for server to become responsive
    const ready = await waitForServer(DEFAULT_PORT, 4000);
    if (!ready) {
      console.warn('\x1b[33mWarning: Server startup taking longer than expected. Continuing...\x1b[0m');
    }
  } else {
    // Notify running server of workspace change
    try {
      await postJson(`http://localhost:${DEFAULT_PORT}/api/workspace/open`, { path: targetDir });
    } catch (e) {}
  }

  // 2. Determine target frontend URL
  const isViteRunning = await pingServer(VITE_PORT);
  const webPort = isViteRunning ? VITE_PORT : DEFAULT_PORT;
  const launchUrl = `http://localhost:${webPort}/?path=${encodeURIComponent(targetDir)}`;

  // 3. Check for Tauri desktop application binary
  const desktopBinary = findDesktopBinary();
  const forceWeb = args.includes('--web');

  if (desktopBinary && !forceWeb) {
    console.log(`\x1b[36m[Aria IDE]\x1b[0m Launching desktop application...`);
    try {
      const child = spawn(desktopBinary, [targetDir], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      console.log(`\x1b[32m✓ Aria IDE desktop app launched for ${targetDir}\x1b[0m`);
      return;
    } catch (e) {
      console.log(`\x1b[33mFalling back to browser launcher...\x1b[0m`);
    }
  }

  // 4. Open in default system browser
  console.log(`\x1b[32m✓ Launching Aria IDE at:\x1b[0m ${launchUrl}`);
  openUrl(launchUrl);
}

/**
 * Searches for compiled Tauri desktop binary across standard locations
 */
function findDesktopBinary() {
  const candidates = [
    // Local workspace builds
    path.join(ROOT_DIR, 'src-tauri', 'target', 'release', 'aria-ide'),
    path.join(ROOT_DIR, 'src-tauri', 'target', 'debug', 'aria-ide'),
    path.join(ROOT_DIR, 'src-tauri', 'target', 'release', 'aria-ide.exe'),
    // System installed binaries
    '/usr/bin/aria-ide',
    '/usr/local/bin/aria-ide',
    path.join(os.homedir(), '.local', 'bin', 'aria-ide'),
    '/Applications/Aria IDE.app/Contents/MacOS/aria-ide',
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return null;
}

/**
 * Starts Express backend server in detached background process
 */
function startBackgroundServer(targetDir) {
  const serverScript = path.join(ROOT_DIR, 'server', 'index.js');
  const child = spawn(process.execPath, [serverScript], {
    cwd: ROOT_DIR,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      INITIAL_WORKSPACE: targetDir,
    },
  });
  child.unref();
}

/**
 * Pings port to test responsiveness
 */
function pingServer(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/api/system/memory`, { timeout: 600 }, (res) => {
      resolve(res.statusCode === 200 || res.statusCode === 304);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Polls server until ready or timeout
 */
async function waitForServer(port, maxWaitMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await pingServer(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Opens URL in platform default browser
 */
function openUrl(url) {
  const platform = process.platform;
  let command = 'xdg-open';
  let cmdArgs = [url];

  if (platform === 'darwin') {
    command = 'open';
    cmdArgs = [url];
  } else if (platform === 'win32') {
    command = 'cmd.exe';
    cmdArgs = ['/c', 'start', '', url];
  }

  try {
    const child = spawn(command, cmdArgs, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err) {
    console.log(`Please open your browser at: ${url}`);
  }
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, { timeout: 2000 }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const postData = JSON.stringify(body);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
        timeout: 2000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      }
    );
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}
