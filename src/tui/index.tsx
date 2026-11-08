import { render } from "ink";
import { loadOrCreateGatewayToken } from "../core/gateway-token.ts";
import { makeTuiClient, resolveTuiAgent } from "./client.ts";
import { TuiApp } from "./app.tsx";

/**
 * TUI 入口 (四期 M2): bot / bot tui 连接 gateway 进入 Ink 会话视图。
 * 纯客户端语义——退出/崩溃零影响服务端 (detach, 不 abort 生成)。
 */
export async function runTui(opts: { webHost: string; webPort: number }): Promise<void> {
  const { webHost, webPort } = opts;
  const token = loadOrCreateGatewayToken();
  const agentId = await resolveTuiAgent(webHost, webPort, token);
  const client = makeTuiClient(webHost, webPort, process.cwd(), agentId);

  // exitOnCtrlC=false: Ctrl+C 语义自行接管 (busy=中断生成, idle=退出客户端)
  const instance = render(<TuiApp client={client} />, { exitOnCtrlC: false });
  client.connect();
  await instance.waitUntilExit();
  client.close();
}
