import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import { app, dialog } from 'electron';
import { JsonRpcRequest, JsonRpcResponse, JsonRpcEvent } from './types';

export const REQUEST_TIMEOUT_MS = 30_000;
const RESPAWN_DELAY_MS = 2_000;
const MAX_RESPAWN_RETRIES = 5;

// ---------------------------------------------------------------------------
// Deterministic transport error messages (pure; unit-tested without Electron)
// ---------------------------------------------------------------------------

export const TRANSPORT_NOT_RUNNING = 'Python bridge is not running';
export const TRANSPORT_PROCESS_EXITED = 'Python bridge process exited';
export const TRANSPORT_SHUTTING_DOWN = 'Bridge is shutting down';

export function transportTimeoutMessage(
  method: string,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): string {
  return `Request ${method} timed out after ${timeoutMs}ms`;
}

/** JSON-RPC application/transport error from a well-formed error object. */
export function transportRpcErrorMessage(code: number, message: string): string {
  return `[${code}] ${message}`;
}

/** Response line with an id but neither a valid result nor error member. */
export function transportMalformedMessage(id: number): string {
  return `Malformed JSON-RPC response for id ${id}`;
}

/**
 * Classify a parsed response body that claims a numeric id.
 * - `error`: well-formed { code, message }
 * - `result`: has `result` key (value may be null)
 * - `malformed`: anything else (unknown-method is still a well-formed error)
 */
export function classifyRpcResponse(response: {
  result?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
}): 'result' | 'error' | 'malformed' {
  if (response.error != null && typeof response.error === 'object') {
    if (
      typeof (response.error as { code?: unknown }).code === 'number' &&
      typeof (response.error as { message?: unknown }).message === 'string'
    ) {
      return 'error';
    }
    return 'malformed';
  }
  if (Object.prototype.hasOwnProperty.call(response, 'result')) {
    return 'result';
  }
  return 'malformed';
}

type EventHandler = (params: Record<string, unknown>) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

/** Outcome of settling one response against the pending table. */
export type SettleOutcome = 'resolved' | 'rejected' | 'late';

/**
 * Pure pending-request correlator: timeouts, RPC errors, malformed replies,
 * process-exit fan-out, and late responses (unknown id → ignored, no double settle).
 */
export class PendingRpcTable {
  private pending: Map<number, PendingRequest> = new Map();

  get size(): number {
    return this.pending.size;
  }

  has(id: number): boolean {
    return this.pending.has(id);
  }

  add(
    id: number,
    method: string,
    resolve: (value: unknown) => void,
    reject: (reason: Error) => void,
    timer: ReturnType<typeof setTimeout>
  ): void {
    this.pending.set(id, { resolve, reject, timer, method });
  }

  /** Drop a pending entry without settling (e.g. after write failure already rejected). */
  delete(id: number): void {
    const p = this.pending.get(id);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(id);
    }
  }

  /**
   * Settle a JSON-RPC response. Late (unknown id) returns `'late'` and does nothing.
   * Malformed bodies reject with {@link transportMalformedMessage}.
   */
  settle(response: JsonRpcResponse): SettleOutcome {
    const pending = this.pending.get(response.id);
    if (!pending) {
      return 'late';
    }
    clearTimeout(pending.timer);
    this.pending.delete(response.id);

    const kind = classifyRpcResponse(response);
    if (kind === 'error') {
      const err = response.error!;
      pending.reject(new Error(transportRpcErrorMessage(err.code, err.message)));
      return 'rejected';
    }
    if (kind === 'malformed') {
      pending.reject(new Error(transportMalformedMessage(response.id)));
      return 'rejected';
    }
    pending.resolve(response.result);
    return 'resolved';
  }

  /** Reject every pending request with the same error (process exit / shutdown). */
  rejectAll(reason: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
      this.pending.delete(id);
    }
  }
}

// Shape Python sends for events: {"event": "name", "data": {...}}
interface PythonEvent {
  event: string;
  data: Record<string, unknown>;
}

export class PythonBridge {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pendingRequests = new PendingRpcTable();
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
      throw new Error(TRANSPORT_NOT_RUNNING);
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
        reject(new Error(transportTimeoutMessage(method, REQUEST_TIMEOUT_MS)));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.add(id, method, resolve, reject, timer);

      const payload = JSON.stringify(request) + '\n';
      this.process!.stdin!.write(payload, (err) => {
        if (err) {
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

    this.pendingRequests.rejectAll(new Error(TRANSPORT_SHUTTING_DOWN));

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
    const outcome = this.pendingRequests.settle(response);
    if (outcome === 'late') {
      // Late / duplicate id after timeout — deterministic no-op (caller already settled).
      console.warn('[python-bridge] received response for unknown id:', response.id);
      return;
    }
    if (outcome === 'resolved') {
      // Reset respawn counter on successful RPC round-trip (not just any JSON line).
      // This prevents infinite respawn loops when Python crashes after a startup message.
      this.respawnRetries = 0;
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

    this.pendingRequests.rejectAll(new Error(TRANSPORT_PROCESS_EXITED));

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
