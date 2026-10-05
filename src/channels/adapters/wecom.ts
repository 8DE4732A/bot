import type { ChannelAdapter } from "../base.ts";
import { logger } from "../../utils/logger.ts";

export interface WeComCredentials {
  botId?: string;
  secret?: string;
  websocketUrl?: string;
  corpId?: string;
  corpSecret?: string;
  agentId?: string;
}

export class WeComChannelAdapter implements ChannelAdapter {
  readonly type = "wecom" as const;
  readonly id: string;
  readonly name: string;
  private credentials: WeComCredentials;

  constructor(id: string, name: string, credentials: WeComCredentials) {
    this.id = id;
    this.name = name;
    this.credentials = credentials;
  }

  public async start(): Promise<void> {
    logger.info("WeComAdapter", `[${this.id}] WeCom channel adapter ready (Phase 2 integration)`);
  }

  public async stop(): Promise<void> {
    logger.info("WeComAdapter", `[${this.id}] WeCom channel adapter stopped`);
  }

  public async sendMessage(peerId: string, content: string): Promise<void> {
    logger.info("WeComAdapter", `[${this.id}] Outbound message to ${peerId}: ${content.slice(0, 50)}...`);
  }
}
