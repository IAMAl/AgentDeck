import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'http';
import type { BridgeEvent, PluginCommand } from './types.js';
import { isLocalConnection, validateToken } from './auth.js';
import { debug } from './logger.js';
import { WS_PING_INTERVAL_MS } from '@agentdeck/shared';

export class WsServer {
  private wss: WebSocketServer;
  private commandCallback: ((cmd: PluginCommand) => void) | null = null;
  private rawMessageCallback: ((msg: Record<string, unknown>, sender: WebSocket) => boolean) | null = null;
  private binaryCallback: ((data: Buffer, sender: WebSocket) => void) | null = null;
  private onConnectCallback: ((ws: WebSocket) => void) | null = null;
  private onDisconnectCallback: ((ws: WebSocket) => void) | null = null;
  private clientAlive = new Map<WebSocket, boolean>();
  private esp32Clients = new Set<WebSocket>();
  private eventTransformer: ((event: BridgeEvent, client: WebSocket) => BridgeEvent | null) | null = null;
  // Clients that registered as the Ulanzi Studio plugin. Their WebSocket
  // presence is the daemon's D200H connectivity signal.
  private ulanziClients = new Set<WebSocket>();
  // TUI dashboards (`agentdeck dashboard`) that registered via
  // `client_register {clientType:"tui"}`. Volunteer-roster model like the
  // Stream Deck plugin — presence only lives as long as the WS does, so the
  // topology row disappears the moment the TUI exits.
  private tuiClients = new Map<WebSocket, { id: string; name: string }>();
  private pingTimer: ReturnType<typeof setInterval>;

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server });

    // Catch server-level errors (e.g., upgrade failures, internal ws errors)
    // Without this handler, EventEmitter throws synchronously → process dies
    this.wss.on('error', (err) => {
      debug('WS', `WebSocketServer error: ${err}`);
    });

    // Server-side ping/pong to detect zombie connections
    this.pingTimer = setInterval(() => {
      const dead: WebSocket[] = [];
      for (const ws of this.wss.clients) {
        if (this.clientAlive.get(ws) === false) {
          dead.push(ws);
          continue;
        }
        this.clientAlive.set(ws, false);
        ws.ping();
      }
      // Terminate outside iteration — ws.terminate() synchronously removes
      // the client from wss.clients Set, which would corrupt the iterator.
      for (const ws of dead) {
        debug('WS', 'Terminating unresponsive client');
        this.clientAlive.delete(ws);
        ws.terminate();
      }
    }, WS_PING_INTERVAL_MS);

    this.wss.on('connection', (ws, req: IncomingMessage) => {
      // Token auth for remote connections
      const remoteIp = req.socket.remoteAddress || '';
      if (!isLocalConnection(remoteIp)) {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const token = url.searchParams.get('token') || '';
        if (!validateToken(token)) {
          debug('WS', `Rejected remote connection from ${remoteIp} (invalid token)`);
          ws.close(4001, 'Unauthorized');
          return;
        }
        debug('WS', `Remote client authenticated from ${remoteIp}`);
      }
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (url.searchParams.get('clientType') === 'esp32' || url.searchParams.get('esp32') === '1') {
        this.esp32Clients.add(ws);
        debug('WS', 'ESP32 WiFi client tagged from query');
      }

      debug('WS', 'Plugin connected');
      this.clientAlive.set(ws, true);

      // Send current state to newly connected client
      if (this.onConnectCallback) {
        this.onConnectCallback(ws);
      }

      ws.on('pong', () => {
        this.clientAlive.set(ws, true);
      });

      ws.on('message', (data, isBinary) => {
        // Binary frames are device audio (voice capture), not JSON — route
        // them out before the parser, which would otherwise log a parse error
        // per 1 KB PCM frame.
        if (isBinary) {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          this.binaryCallback?.(buf, ws);
          return;
        }
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          debug('WS', `recv cmd: ${msg.type}`);
          // Track Ulanzi plugin presence for D200H health reporting.
          if (msg.type === 'client_register' && msg.clientType === 'ulanzi-plugin') {
            const was = this.ulanziClients.size > 0;
            this.ulanziClients.add(ws);
            if (!was) {
              debug('WS', 'Ulanzi plugin registered — D200H connected');
            }
          }
          // Track TUI dashboard presence (topology row on all dashboards).
          if (msg.type === 'client_register' && msg.clientType === 'tui') {
            const dev = (Array.isArray(msg.devices) ? msg.devices[0] : null) as
              | { id?: unknown; name?: unknown }
              | null;
            const name = typeof dev?.name === 'string' && dev.name ? dev.name : 'terminal';
            const id = typeof dev?.id === 'string' && dev.id ? dev.id : name;
            this.tuiClients.set(ws, { id, name });
            debug('WS', `TUI dashboard registered: ${id}`);
          }
          // Allow raw message callback to intercept relay events (e.g. deck_slot_map)
          if (this.rawMessageCallback && this.rawMessageCallback(msg, ws)) {
            return; // handled
          }
          if (this.commandCallback) {
            this.commandCallback(msg as unknown as PluginCommand);
          }
        } catch (err) {
          debug('WS', `Failed to parse message: ${err}`);
        }
      });

      ws.on('close', () => {
        debug('WS', 'Plugin disconnected');
        this.clientAlive.delete(ws);
        this.esp32Clients.delete(ws);
        this.tuiClients.delete(ws);
        if (this.ulanziClients.delete(ws) && this.ulanziClients.size === 0) {
          debug('WS', 'Ulanzi plugin gone — D200H disconnected');
        }
        if (this.onDisconnectCallback) {
          this.onDisconnectCallback(ws);
        }
      });

      ws.on('error', (err) => {
        debug('WS', `WebSocket error: ${err}`);
      });
    });
  }

  private broadcastHooks: Array<(event: BridgeEvent) => void> = [];

  /** Register a hook that gets called on every broadcast (e.g., ESP32 serial relay). */
  onBroadcast(hook: (event: BridgeEvent) => void): void {
    this.broadcastHooks.push(hook);
  }

  setEventTransformer(transformer: ((event: BridgeEvent, client: WebSocket) => BridgeEvent | null) | null): void {
    this.eventTransformer = transformer;
  }

  isEsp32Client(ws: WebSocket): boolean {
    return this.esp32Clients.has(ws);
  }

  markEsp32Client(ws: WebSocket): void {
    this.esp32Clients.add(ws);
  }

  private payloadFor(event: BridgeEvent, client: WebSocket, cachedPayload?: string): string | null {
    if (!this.eventTransformer) return cachedPayload ?? JSON.stringify(event);
    const transformed = this.eventTransformer(event, client);
    if (!transformed) return null;
    return transformed === event ? (cachedPayload ?? JSON.stringify(event)) : JSON.stringify(transformed);
  }

  broadcast(event: BridgeEvent): void {
    const payload = JSON.stringify(event);
    const clientCount = this.wss.clients.size;
    debug('WS', `broadcast(${event.type}) to ${clientCount} clients`);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        const clientPayload = this.payloadFor(event, client, payload);
        if (!clientPayload) continue;
        try { client.send(clientPayload); } catch { /* client disconnecting */ }
      }
    }
    // Relay to registered hooks (ESP32 serial, etc.)
    for (const hook of this.broadcastHooks) {
      try { hook(event); } catch { /* best-effort */ }
    }
  }

  onCommand(callback: (cmd: PluginCommand) => void): void {
    this.commandCallback = callback;
  }

  /** Register a callback for binary frames (device audio). */
  onBinary(callback: (data: Buffer, sender: WebSocket) => void): void {
    this.binaryCallback = callback;
  }

  /** Register a callback for raw messages before PluginCommand dispatch. Return true to consume. */
  onRawMessage(callback: (msg: Record<string, unknown>, sender: WebSocket) => boolean): void {
    this.rawMessageCallback = callback;
  }

  /** Broadcast to all clients except the sender */
  broadcastExcept(event: BridgeEvent, except: WebSocket): void {
    const payload = JSON.stringify(event);
    for (const client of this.wss.clients) {
      if (client !== except && client.readyState === WebSocket.OPEN) {
        const clientPayload = this.payloadFor(event, client, payload);
        if (!clientPayload) continue;
        try { client.send(clientPayload); } catch { /* client disconnecting */ }
      }
    }
  }

  onClientConnect(callback: (ws: WebSocket) => void): void {
    this.onConnectCallback = callback;
  }

  onClientDisconnect(callback: (ws: WebSocket) => void): void {
    this.onDisconnectCallback = callback;
  }

  sendTo(ws: WebSocket, event: BridgeEvent): void {
    if (ws.readyState === WebSocket.OPEN) {
      const payload = this.payloadFor(event, ws);
      if (!payload) return;
      try { ws.send(payload); } catch { /* client disconnecting */ }
    }
  }

  getClientCount(): number {
    return this.wss.clients.size;
  }

  getUlanziClientCount(): number {
    return this.ulanziClients.size;
  }

  /** Registered TUI dashboards (`client_register {clientType:"tui"}`), deduped
   *  by client id so a TUI that reconnects (new WS, same host+pid) yields one
   *  entry while both sockets briefly overlap. */
  getTuiClients(): Array<{ id: string; name: string }> {
    const byId = new Map<string, { id: string; name: string }>();
    for (const info of this.tuiClients.values()) byId.set(info.id, info);
    return [...byId.values()];
  }

  close(): void {
    clearInterval(this.pingTimer);
    this.clientAlive.clear();
    // Spread to array — client.close() modifies wss.clients Set
    for (const client of [...this.wss.clients]) {
      client.close();
    }
    this.wss.close();
  }
}
