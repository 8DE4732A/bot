import type { ChannelAdapter } from "../base.ts";
import { logger } from "../../utils/logger.ts";

export interface QQBotCredentials {
  appId?: string;
  clientSecret?: string;
}

export class QQChannelAdapter implements ChannelAdapter {
  readonly type = "qq" as const;
  readonly id: string;
  readonly name: string;
  private credentials: QQBotCredentials;

  constructor(id: string, name: string, credentials: QQBotCredentials) {
    this.id = id;
    this.name = name;
    this.credentials = credentials;
  }

  public async start(): Promise<void> {
    logger.info("QQAdapter", `[${this.id}] QQ Open Platform Bot channel ready (Phase 2 integration)`);
  }

  public async stop(): Promise<void> {
    logger.info("QQAdapter", `[${this.id}] QQ Bot channel stopped`);
  }

  public async sendMessage(peerId: string, content: string): Promise<void> {
    logger.info("QQAdapter", `[${this.id}] Outbound QQ message to ${peerId}: ${content.slice(0, 50)}...`);
  }
}
