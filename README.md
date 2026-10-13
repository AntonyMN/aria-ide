<div align="center">

# ⚡ Aria IDE

**An Open-Source, Autonomous AI Software Engineering Environment Powered by Free, Self-Hosted Local LLMs**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2-FFC131?logo=tauri&logoColor=black)](https://tauri.app/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Ollama](https://img.shields.io/badge/Ollama-Local_Inference-white?logo=ollama&logoColor=black)](https://ollama.ai/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[Website / Docs](https://antonymn.github.io/aria-ide/) • [Why Aria?](#-why-aria-ide-was-created) • [Features](#-features) • [Quick Start](#-quick-start) • [Packaging & Installers](#-building-desktop-installers-deb-exe-dmg) • [GitHub Pages](#-how-github-pages-works-for-aria-ide) • [License](#-license)

</div>

---

## 🌟 Why Aria IDE Was Created

Modern software development is experiencing a revolution driven by autonomous AI coding assistants. However, almost all commercial solutions share three critical flaws:
1. **Expensive Subscriptions & Per-Token Metering**: Developers are billed for every token, prompt, and execution step.
2. **Privacy Risks & Code Leaks**: Proprietary codebases and sensitive credentials are sent across the public internet to third-party cloud servers.
3. **Hidden / Black-Box Background Executions**: Standard AI agents often run terminal commands silently in the background, making it impossible to see real-time errors, infinite loops, or accidental directory mutations.

**The mission of Aria IDE is to democratize autonomous AI software engineering:**
- **100% Free & Open-Source (MIT License)**: Anyone, anywhere in the world, can clone, run, and customize this IDE without paying subscriptions or API fees.
- **Runs Completely Locally on Your Laptop**: Powered by self-hosted [Ollama](https://ollama.ai) models (e.g. `granite4.2:8b`, `qwen2.5-coder:7b`, `deepseek-coder:6.7b`). Your code, files, and thoughts never leave your machine.
- **Transparent On-Screen Execution**: Every command runs live on screen with streaming stdout/stderr chunks and sequential dependency safety.
- **Intelligent Workspace Auditing**: When scaffolding commands create directories (e.g. `laravel new blog`, `npx create-vite-app myapp`), Aria detects the filesystem diff, automatically navigates into the new folder, and uses the local LLM to formulate the immediate next steps.

---

## 🚀 Features

### 📺 1. Live On-Screen Command Execution
- No more hidden background processes. Terminal commands stream real-time `stdout` and `stderr` directly into the on-screen console box.
- Guaranteed synchronous execution: dependent commands execute strictly one after another.
- Interactive Command Pipeline: Inspect historical output, exit codes, and diffs for any command in the queue.

### 📁 2. File Structure Analysis & LLM Way Forward
- Pre- and post-execution filesystem diffing automatically detects new folders and created files.
- Automatically transitions the active working directory (CWD) into newly scaffolded project folders (e.g. `laravel new blog` ➔ `./blog`).
- Coordinates with the interactive xterm terminal PTY, keeping the developer's shell synchronized.
- Local LLM evaluates the result and presents an actionable **Way Forward** along with clickable chips for suggested next commands (e.g. `composer install`, `npm install`).

### ⏸️ 3. Human-in-the-Loop Interruption & Plan Revision
- Interrupt the AI at any time mid-generation or mid-execution.
- The system pauses cleanly, accepts your guidance or updated requirements, and queries the local LLM to dynamically update `IMPLEMENTATION_PLAN.md` and display the changes in Monaco editor.

### 💻 4. Hardware & VRAM Memory Safety Engine
- Automatically probes installed Ollama models and calculates physical RAM and VRAM footprints (model weights, KV cache, and runtime overhead).
- Labels models with safety indicators (`SAFE`, `MODERATE`, `HIGH RISK`) against your computer's actual available RAM to prevent out-of-memory lockups.

### 📝 5. Monaco Editor with Split Diff Review
- Full Monaco-powered code editing.
- Side-by-side diff reviews for changes proposed by the AI agent with one-click **Accept** or **Revert**.

---

## 🛠️ Quick Start

### 1. Prerequisites
- **Node.js**: v18.0.0 or higher (v20+ recommended)
- **Rust toolchain** (optional, required only for native Tauri desktop packaging): [rustup.rs](https://rustup.rs/)
- **Ollama**: [Download & install Ollama](https://ollama.ai)

### 2. Pull Recommended Local Models
Open your terminal and pull your preferred coding models:
```bash
# High-quality coding & tool-calling model (recommended for 16GB RAM)
ollama pull granite4.2:8b

# Excellent multi-language coding models
ollama pull qwen2.5-coder:7b
ollama pull deepseek-coder:6.7b

# Lightweight models for 8GB RAM laptops
ollama pull qwen2.5-coder:1.5b
ollama pull deepseek-coder:1.3b
```

### 3. Clone & Run in Development Mode
```bash
# Clone the repository
git clone https://github.com/AntonyMN/aria-ide.git
cd aria-ide

# Install dependencies
npm install

# Start the full-stack development environment (Backend + Frontend)
npm run dev
```
Once started:
- Frontend will be available at: `http://localhost:5173`
- Backend server will be active at: `http://localhost:3001`

---

## 🚀 Launching from Terminal (`aria .`)

Just like `code .` for VS Code, you can open any folder in Aria IDE directly from your terminal:

```bash
cd ~/my-awesome-project
aria .
```

### Adding `aria` to your PATH

#### Option A: One-Command Installation (Linux & macOS)
```bash
npm run install-cli
# or directly:
bash scripts/install-cli.sh
```
This automatically links the `aria` launcher into `~/.local/bin/aria` (no root/sudo needed).

#### Option B: Windows PowerShell
```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-cli.ps1
```

#### Option C: In-App 1-Click Installation
Inside Aria IDE:
- Click the **`aria .`** button in the top navigation header next to your workspace path.
- Or open the Workspace Picker modal and click **Install "aria" in PATH**.

#### Option D: Global NPM Installation
```bash
npm install -g .
# or
npm link
```

### CLI Command Options
```bash
aria .                  # Open current folder in Aria IDE
aria ~/projects/blog    # Open target path directly
aria --status           # Check background server & RAM usage of loaded models
aria --install-cli      # Re-install or verify CLI symlink in PATH
aria --version          # Print Aria IDE version
aria --help             # Display all CLI options
```

---

## 📦 Building Desktop Installers (.deb, .exe, .dmg)

Aria IDE is built on top of **Tauri v2**, which compiles native, lightweight binary installers across Linux, Windows, and macOS.

### 🐧 1. Linux Installers (`.deb` & `.AppImage`)

On Ubuntu, Debian, or Linux Mint:

```bash
# 1. Install system prerequisites
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev

# 2. Build Linux bundles
npm run tauri build -- --bundles deb,appimage
```
**Output Locations:**
- Debian Package: `src-tauri/target/release/bundle/deb/aria-ide_0.1.0_amd64.deb`
- Universal AppImage: `src-tauri/target/release/bundle/appimage/aria-ide_0.1.0_amd64.AppImage`

**To Install the `.deb`:**
```bash
sudo dpkg -i src-tauri/target/release/bundle/deb/aria-ide_0.1.0_amd64.deb
```

---

### 🪟 2. Windows Installers (`.exe` & `.msi`)

On Windows 10/11:

```powershell
# 1. Prerequisites:
# - Microsoft Visual Studio C++ Build Tools
# - Rust (rustup default stable-x86_64-pc-windows-msvc)
# - WebView2 runtime (pre-installed on Windows 10/11)

# 2. Build Windows executable and installer
npm run tauri build -- --bundles nsis,msi
```
**Output Locations:**
- NSIS Setup Executable: `src-tauri/target/release/bundle/nsis/aria-ide_0.1.0_x64-setup.exe`
- MSI Windows Installer: `src-tauri/target/release/bundle/msi/aria-ide_0.1.0_x64_en-US.msi`

---

### 🍏 3. macOS Installers (`.dmg` & `.app`)

On macOS (Intel or Apple Silicon M1/M2/M3/M4):

```bash
# 1. Prerequisites:
# - Xcode Command Line Tools: xcode-select --install
# - Rust: rustup target add aarch64-apple-darwin x86_64-apple-darwin

# 2. Build universal bundle for both Intel and Apple Silicon
npm run tauri build -- --bundles dmg,app --target universal-apple-darwin
```
**Output Locations:**
- Apple Disk Image: `src-tauri/target/release/bundle/dmg/aria-ide_0.1.0_universal.dmg`
- macOS App Bundle: `src-tauri/target/release/bundle/macos/aria-ide.app`

---

### 🤖 4. Automated Multi-Platform CI/CD with GitHub Actions

The repository includes [`.github/workflows/release.yml`](.github/workflows/release.yml). 

Whenever you push a version tag:
```bash
git tag v0.1.0
git push origin v0.1.0
```
GitHub Actions will automatically spin up Ubuntu, Windows, and macOS virtual runners simultaneously, build all `.deb`, `.AppImage`, `.exe`, and `.dmg` installers, and attach them directly to your GitHub Releases page!

---

## 🌐 How GitHub Pages Works for Aria IDE

GitHub Pages is GitHub's free hosting service for static websites (HTML, CSS, JS).

### Can the desktop IDE run entirely inside GitHub Pages?
- **No, and here is why**: A full autonomous coding IDE requires local OS operating privileges — spawning shell processes (`child_process.spawn`), binding local WebSocket pseudoterminals (`node-pty`), reading physical disk directories, and querying local Ollama ports (`127.0.0.1:11434`). A static browser sandbox on GitHub Pages cannot perform low-level OS operations without a native desktop or backend shell.

### How GitHub Pages is used for Aria IDE:
- GitHub Pages is used to host the **Official Showcase & Documentation Portal** located in the [`docs/`](docs/) directory.
- Visitors to your GitHub Pages site (`https://<username>.github.io/aria-ide`) can view features, screenshots, documentation, and click direct download buttons for the latest `.deb`, `.exe`, and `.dmg` releases.

### Enabling GitHub Pages on your repository:
1. Push your repository to GitHub.
2. In GitHub, go to **Settings** ➔ **Pages**.
3. Under **Build and deployment**:
   - **Source**: Select **GitHub Actions** (the included [`.github/workflows/pages.yml`](.github/workflows/pages.yml) will automatically deploy the site on every push).
   - Alternatively, choose **Deploy from a branch** ➔ select branch `master` or `main` ➔ select folder `/docs` ➔ click **Save**.
4. Your website will be live in ~60 seconds at `https://<your-username>.github.io/aria-ide/`.

---

## 🤝 Contributing

Contributions from the developer community are warmly welcomed!
1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m "Add amazing feature"`
4. Push to branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details. You are free to use, modify, distribute, and integrate Aria IDE in your personal or commercial workflows.
