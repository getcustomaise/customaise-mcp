/**
 * ExtensionBridge — WebSocket server that connects the MCP server to the
 * Customaise Chrome extension.
 *
 * Architecture:
 *   MCP Server (stdio) ←→ ExtensionBridge (WS server :4050) ←→ Extension SW (WS client)
 *
 * The MCP Node process hosts the WebSocket server because MV3 service workers
 * cannot run servers. The extension connects as a WebSocket client.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

/** Shape of a request sent to the extension */
interface BridgeRequest {
  id: string;
  type: string;
  args: Record<string, unknown>;
}

/** Shape of a response received from the extension */
interface BridgeResponse {
  id: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ExtensionBridge {
  private wss: WebSocketServer | null = null;
  private extensionSocket: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private port: number;
  private requestTimeoutMs: number;

  constructor(port = 4050, requestTimeoutMs = 30_000) {
    this.port = port;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  /**
   * Start the WebSocket server and begin listening for the extension client.
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: this.port }, () => {
        this._log(`WebSocket server listening on ws://localhost:${this.port}`);
        resolve();
      });

      this.wss.on('error', (err) => {
        this._log(`WebSocket server error: ${err.message}`);
        reject(err);
      });

      this.wss.on('connection', (ws) => {
        this._log('Extension client connected');

        // Only allow one client at a time (the Customaise extension)
        if (this.extensionSocket) {
          this._log('Replacing existing extension connection');
          this.extensionSocket.close(1000, 'Replaced by new connection');
        }

        this.extensionSocket = ws;

        ws.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString()) as BridgeResponse;
            this._handleResponse(message);
          } catch (err) {
            this._log(`Failed to parse message from extension: ${err}`);
          }
        });

        ws.on('close', (code, reason) => {
          this._log(`Extension client disconnected (code=${code}, reason=${reason.toString()})`);
          if (this.extensionSocket === ws) {
            this.extensionSocket = null;
          }
        });

        ws.on('error', (err) => {
          this._log(`Extension client error: ${err.message}`);
        });
      });
    });
  }

  /**
   * Send a request to the extension and wait for the response.
   * Throws if the extension is not connected or the request times out.
   */
  async request(type: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.extensionSocket || this.extensionSocket.readyState !== WebSocket.OPEN) {
      throw new Error(
        'Customaise extension is not connected. Make sure Chrome is running with the Customaise extension loaded.'
      );
    }

    const id = randomUUID();

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request to extension timed out after ${this.requestTimeoutMs}ms (type=${type}, id=${id})`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      const request: BridgeRequest = { id, type, args };
      this.extensionSocket!.send(JSON.stringify(request));
    });
  }

  /**
   * Whether the extension is currently connected.
   */
  get isConnected(): boolean {
    return this.extensionSocket !== null && this.extensionSocket.readyState === WebSocket.OPEN;
  }

  /**
   * Close the WebSocket server and all connections.
   */
  async close(): Promise<void> {
    // Reject all pending requests
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Bridge is shutting down'));
    }
    this.pending.clear();

    if (this.extensionSocket) {
      this.extensionSocket.close(1000, 'MCP server shutting down');
      this.extensionSocket = null;
    }

    return new Promise((resolve) => {
      if (this.wss) {
        this.wss.close(() => {
          this.wss = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle an incoming response from the extension, matching it to a pending request.
   */
  private _handleResponse(message: BridgeResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      this._log(`Received response for unknown request id: ${message.id}`);
      return;
    }

    this.pending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.success) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(message.error || 'Extension returned an error'));
    }
  }

  /**
   * Log to stderr (stdout is reserved for MCP stdio transport).
   */
  private _log(message: string): void {
    process.stderr.write(`[customaise-mcp] ${message}\n`);
  }
}
