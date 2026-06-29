import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import { app, dialog } from 'electron';
import { JsonRpcRequest, JsonRpcResponse, JsonRpcEvent } from './types';

const REQUEST_TIMEOUT_MS = 30_000;
const RESPAWN_DELAY_MS = 2_000;
const MAX_RESPAWN_RETRIES = 5;

type EventHandler = (params: Record<string, unknown>) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Shape Python sends for events: {"event": "name", "data": {...}}
interface PythonEvent {
  event: string;
  data: Record<string, unknown>;
}

export class PythonBridge {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pendingRequests: Map<number, PendingRequest> = new Map();
  private eventHandlers: Map<string, Set<EventHandler>> = new Map();
  private lineBuffer = '';
  private isQuitting = false;
  private isReady = false;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private respawnRetries = 0;

  /** Start the Python bridge child process. */
  spawn(): Promise<void> {
    if (this.process) {
      return Promise.resolve();
    }

    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });

    const bridgePath = this.getBridgePath();
    const isPackaged = app.isPackaged;

    // Point the Python media-tools locator at the BUNDLED 7-Zip + ffprobe so
    // audiobook processing never depends on the user having them installed.
    // Packaged: resources/bin (extraResources); dev: electron-app/bin.
    const binDir = isPackaged
      ? path.join(process.resourcesPath, 'bin')
      : path.join(app.getAppPath(), 'bin');
    const env = {
      ...process.env,
      SAN_CITRO_7Z: path.join(binDir, '7z.exe'),
      SAN_CITRO_FFPROBE: path.join(binDir, 'ffprobe.exe'),
    };

    if (isPackaged && bridgePath.endsWith('.exe')) {
      this.process = spawn(bridgePath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env,
      });
    } else {
      // Determine the Python binary — respect SAN_CITRO_PYTHON env var
      const pythonBin = process.env.SAN_CITRO_PYTHON || 'python';
      this.process = spawn(pythonBin, [bridgePath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        cwd: path.join(app.getAppPath(), '..'),
        env,
      });
    }

    this.lineBuffer = '';
    this.isReady = false;

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.handleStdoutChunk(chunk.toString('utf-8'));
    });

    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim();
      if (text) {
        console.error('[python-bridge:stderr]', text);
      }
    });

    this.process.on('exit', (code, signal) => {
      console.error(`[python-bridge] exited code=${code} signal=${signal}`);
      this.handleProcessExit();
    });

    this.process.on('error', (err) => {
      console.error('[python-bridge] spawn error:', err.message);
      this.handleProcessExit();
    });

    // Mark ready after a short delay if no explicit ready signal
    // The bridge is considered ready once it starts outputting JSON-RPC
    setTimeout(() => {
      if (!this.isReady && this.readyResolve) {
        this.isReady = true;
        this.readyResolve();
        this.readyResolve = null;
      }
    }, 3_000);

    return this.readyPromise;
  }

  /** Send a JSON-RPC call and wait for the response. */
  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.process?.stdin?.writable) {
      throw new Error('Python bridge is not running');
    }

    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined && { params }),
    };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timer });

      const payload = JSON.stringify(request) + '\n';
      this.process!.stdin!.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(new Error(`Failed to write to bridge stdin: ${err.message}`));
        }
      });
    });
  }

  /** Subscribe to a server-push event. */
  on(event: string, handler: EventHandler): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  /** Unsubscribe from a server-push event. */
  off(event: string, handler: EventHandler): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  /** Gracefully shut down the Python process. */
  async kill(): Promise<void> {
    this.isQuitting = true;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Bridge is shutting down'));
      this.pendingRequests.delete(id);
    }

    if (!this.process) {
      return;
    }

    // Try graceful shutdown via JSON-RPC quit command
    try {
      const quitPayload = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'quit' }) + '\n';
      this.process.stdin?.write(quitPayload);
    } catch {
      // stdin may already be closed
    }

    // Wait up to 5s for graceful exit, then force kill
    await new Promise<void>((resolve) => {
      const forceKillTimer = setTimeout(() => {
        if (this.process) {
          console.warn('[python-bridge] force killing after timeout');
          // On Windows, use taskkill via execFile to kill the entire process tree
          // (child processes like download workers would otherwise become zombies).
          // execFile is used instead of exec to prevent shell injection.
          if (process.platform === 'win32' && this.process.pid) {
            try {
              require('child_process').execFileSync(
                'taskkill', ['/F', '/T', '/PID', String(this.process.pid)],
                { windowsHide: true, timeout: 5000 }
              );
            } catch {
              this.process.kill();
            }
          } else {
            this.process.kill('SIGKILL');
          }
        }
        resolve();
      }, 5_000);

      if (this.process) {
        this.process.once('exit', () => {
          clearTimeout(forceKillTimer);
          resolve();
        });
      } else {
        clearTimeout(forceKillTimer);
        resolve();
      }
    });

    this.process = null;
  }

  /** Returns true if the bridge process is alive. */
  get isAlive(): boolean {
    return this.process !== null && !this.process.killed;
  }

  // --- Private ---

  private getBridgePath(): string {
    if (app.isPackaged) {
      const exePath = path.join(process.resourcesPath, 'python', 'bridge.exe');
      const pyPath = path.join(process.resourcesPath, 'python', 'bridge.py');
      // Prefer bundled executable
      try {
        require('fs').accessSync(exePath);
        return exePath;
      } catch {
        return pyPath;
      }
    }
    // Development: bridge.py is inside electron-app/python/
    return path.join(app.getAppPath(), 'python', 'bridge.py');
  }

  private handleStdoutChunk(chunk: string): void {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split('\n');

    // Keep the last incomplete line in the buffer
    this.lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.parseLine(trimmed);
    }
  }

  private parseLine(line: string): void {
    let parsed: Record<string, unknown>;

    try {
      parsed = JSON.parse(line);
    } catch {
      // Not JSON -- might be a startup log line from Python
      console.log('[python-bridge:stdout]', line);
      return;
    }

    // Mark bridge as ready on first valid JSON-RPC message
    if (!this.isReady && this.readyResolve) {
      this.isReady = true;
      this.readyResolve();
      this.readyResolve = null;
    }

    // Reset respawn counter only after a successful RPC response (not just any JSON).
    // This prevents infinite respawn loops when Python emits a startup message then crashes.
    // The counter is reset in handleResponse() instead.

    // #5: Python sends events as {"event": "name", "data": {...}}
    // Route them before checking for JSON-RPC format
    if ('event' in parsed) {
      const pyEvent = parsed as unknown as PythonEvent;
      this.handleEvent({
        jsonrpc: '2.0',
        method: pyEvent.event,
        params: pyEvent.data ?? {},
      });
      return;
    }

    // Check if this is a response (has id) or a JSON-RPC event notification (has method, no id)
    if ('id' in parsed && typeof parsed.id === 'number') {
      this.handleResponse(parsed as unknown as JsonRpcResponse);
    } else if ('method' in parsed) {
      this.handleEvent(parsed as unknown as JsonRpcEvent);
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      console.warn('[python-bridge] received response for unknown id:', response.id);
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(response.id);

    if (response.error) {
      pending.reject(
        new Error(`[${response.error.code}] ${response.error.message}`)
      );
    } else {
      // Reset respawn counter on successful RPC round-trip (not just any JSON line).
      // This prevents infinite respawn loops when Python crashes after a startup message.
      this.respawnRetries = 0;
      pending.resolve(response.result);
    }
  }

  private handleEvent(event: JsonRpcEvent): void {
    const handlers = this.eventHandlers.get(event.method);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event.params);
        } catch (err) {
          console.error(`[python-bridge] event handler error for ${event.method}:`, err);
        }
      }
    }
  }

  private handleProcessExit(): void {
    this.process = null;

    // Reject readyPromise if bridge died before becoming ready
    if (!this.isReady && this.readyResolve) {
      // readyResolve is actually a resolve function, not reject.
      // Just mark as ready so spawn() doesn't hang — caller will get errors on first call.
      this.isReady = true;
      this.readyResolve();
      this.readyResolve = null;
    }

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Python bridge process exited'));
      this.pendingRequests.delete(id);
    }

    // #16: Auto-respawn with retry limit
    if (!this.isQuitting) {
      this.respawnRetries++;

      if (this.respawnRetries > MAX_RESPAWN_RETRIES) {
        console.error(`[python-bridge] exhausted ${MAX_RESPAWN_RETRIES} respawn retries`);
        dialog.showErrorBox(
          'San Citro - Backend Error',
          `The Python backend has crashed ${MAX_RESPAWN_RETRIES} times and will not be restarted. ` +
          'Please restart the application. If the problem persists, check the logs or reinstall.',
        );
        return;
      }

      console.log(`[python-bridge] will respawn in ${RESPAWN_DELAY_MS}ms (attempt ${this.respawnRetries}/${MAX_RESPAWN_RETRIES})`);
      setTimeout(() => {
        if (!this.isQuitting) {
          this.spawn().catch((err) => {
            console.error('[python-bridge] respawn failed:', err);
          });
        }
      }, RESPAWN_DELAY_MS);
    }
  }
}
