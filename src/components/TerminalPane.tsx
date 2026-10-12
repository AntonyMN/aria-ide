import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Trash2, RotateCw } from 'lucide-react';

interface Props {
  currentCwd: string;
}

export const TerminalPane: React.FC<Props> = ({ currentCwd }) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const termInstanceRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!terminalRef.current) return;

    // Initialize xterm
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 12.5,
      theme: {
        background: '#05070a',
        foreground: '#e2e8f0',
        cursor: '#00f0ff',
        selectionBackground: 'rgba(0, 240, 255, 0.3)',
        black: '#000000',
        red: '#ef4444',
        green: '#10b981',
        yellow: '#f59e0b',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#00f0ff',
        white: '#ffffff',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();

    termInstanceRef.current = term;
    fitAddonRef.current = fitAddon;

    // Connect WebSocket
    const connectWs = () => {
      const ws = new WebSocket('ws://localhost:3001');
      wsRef.current = ws;

      ws.onopen = () => {
        term.writeln('\x1b[32m✔ Connected to local interactive shell session.\x1b[0m\r\n');
        if (currentCwd) {
          ws.send(JSON.stringify({ type: 'set_cwd', cwd: currentCwd }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          if (parsed.type === 'output') {
            term.write(parsed.data);
          } else if (parsed.type === 'exit') {
            term.writeln(`\r\n\x1b[33mProcess exited with code ${parsed.exitCode}\x1b[0m\r\n`);
          }
        } catch (e) {
          term.write(event.data);
        }
      };

      ws.onerror = () => {
        term.writeln('\r\n\x1b[31m[WebSocket Terminal Error: Backend not reached on ws://localhost:3001]\x1b[0m\r\n');
      };

      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data }));
        }
      });

      term.onResize(({ cols, rows }) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
      });
    };

    connectWs();

    const handleResize = () => {
      try {
        fitAddon.fit();
      } catch (e) {}
    };
    window.addEventListener('resize', handleResize);

    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch (e) {}
    });
    if (terminalRef.current) {
      resizeObserver.observe(terminalRef.current);
    }

    return () => {
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      if (wsRef.current) wsRef.current.close();
      term.dispose();
    };
  }, []);

  const clearTerminal = () => {
    termInstanceRef.current?.clear();
  };

  const restartTerminal = () => {
    termInstanceRef.current?.clear();
    termInstanceRef.current?.writeln('\x1b[33mRestarting shell session...\x1b[0m\r\n');
    if (wsRef.current) {
      wsRef.current.close();
    }
    const ws = new WebSocket('ws://localhost:3001');
    wsRef.current = ws;
    ws.onopen = () => {
      termInstanceRef.current?.writeln('\x1b[32m✔ Connected.\x1b[0m\r\n');
      if (currentCwd) {
        ws.send(JSON.stringify({ type: 'set_cwd', cwd: currentCwd }));
      }
    };
    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (parsed.type === 'output') {
          termInstanceRef.current?.write(parsed.data);
        }
      } catch (e) {}
    };
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
      <div style={{
        height: 28,
        background: '#090d14',
        borderBottom: '1px solid var(--border-color)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 8px',
        fontSize: 11,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-dim)' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent-emerald)' }}></span>
          <span>bash (pty)</span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="icon-btn" title="Clear Terminal" onClick={clearTerminal}>
            <Trash2 size={12} />
          </button>
          <button className="icon-btn" title="Restart Terminal" onClick={restartTerminal}>
            <RotateCw size={12} />
          </button>
        </div>
      </div>
      <div ref={terminalRef} style={{ flex: 1, width: '100%', overflow: 'hidden' }} />
    </div>
  );
};
