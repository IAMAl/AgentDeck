import type { DeviceModule, BridgeContext } from './types.js';
import { advertiseBridge } from '../mdns.js';
import type { AgentType } from '../types.js';

export class MdnsModule implements DeviceModule {
  readonly name = 'mdns';
  private cleanup: (() => void) | null = null;
  private agentType: AgentType;

  constructor(agentType: AgentType) {
    this.agentType = agentType;
  }

  async shouldActivate(_config: 'auto' | boolean): Promise<boolean> {
    // mDNS is lightweight — always activate unless explicitly disabled
    return _config !== false;
  }

  async start(ctx: BridgeContext): Promise<void> {
    // No ctx.authToken here on purpose: the TXT record is multicast, so it
    // must never carry the pairing credential (issue #145).
    this.cleanup = advertiseBridge(ctx.port, ctx.projectName, this.agentType);
  }

  async stop(): Promise<void> {
    this.cleanup?.();
    this.cleanup = null;
  }
}
