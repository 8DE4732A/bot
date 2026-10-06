/**
 * typing 心跳 (对齐 hermes _keep_typing 覆盖模式):
 * agent 处理期间每 intervalMs 调一次 adapter.sendTyping, 回复落地即停。
 * 心跳失败静默 (typing 是纯体验优化, 不允许它干扰投递主流程)。
 */
export function startTypingHeartbeat(
  send: () => Promise<void>,
  intervalMs = 5_000,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const tick = async () => {
    if (stopped) return;
    try {
      await send();
    } catch {
      // 平台限流/瞬时失败忽略, 下一轮再试
    }
  };

  timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
}
