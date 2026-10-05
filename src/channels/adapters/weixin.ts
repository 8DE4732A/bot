import type { ChannelAdapter } from "../base.ts";
import { logger } from "../../utils/logger.ts";

export interface WeixinCredentials {
  token?: string;
  contextToken?: string;
}

export class WeixinChannelAdapter implements ChannelAdapter {
  readonly type = "weixin" as const;
  readonly id: string;
  readonly name: string;
  private credentials: WeixinCredentials;

  constructor(id: string, name: string, credentials: WeixinCredentials) {
    this.id = id;
    this.name = name;
    this.credentials = credentials;
  }

  public async start(): Promise<void> {
    logger.info("WeixinAdapter", `[${this.id}] Weixin iLink Bot channel ready (Phase 2 integration)`);
  }

  public async stop(): Promise<void> {
    logger.info("WeixinAdapter", `[${this.id}] Weixin channel stopped`);
  }

  public async sendMessage(peerId: string, content: string): Promise<void> {
    logger.info("WeixinAdapter", `[${this.id}] Outbound iLink message to ${peerId}: ${content.slice(0, 50)}...`);
  }
}
