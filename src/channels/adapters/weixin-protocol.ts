/**
 * 微信 iLink 协议纯函数：copy-friendly 排版、引用/语音上下文提取。
 * 与网络/适配器状态解耦，便于矩阵测试。
 */

const FENCE = /^\s*(`{3,}|~{3,})/;
const TABLE_RULE = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/;

/**
 * 微信纯文本更适合「可直接复制」的排版：
 * - 标题去掉 # 标记（保留文字）
 * - 表格行转为 `a · b`，分隔行删除
 * - 压缩多余空行、水平分割线转空行
 * - 代码围栏保留给后续通用降级剥离（不在行内插换行，避免破坏代码）
 */
export function formatWeixinCopyFriendly(content: string): string {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let fence: string | undefined;

  for (const line of lines) {
    const fenceMatch = line.match(FENCE);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = marker;
      else if (fence === marker) fence = undefined;
      out.push(line.trimEnd());
      continue;
    }
    if (fence) {
      out.push(line.trimEnd());
      continue;
    }

    if (TABLE_RULE.test(line)) continue;
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push("");
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean);
      out.push(cells.join(" · "));
      continue;
    }
    const heading = line.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/);
    out.push(heading ? heading[1] : line.trimEnd());
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** iLink item 类型（协议单一来源；adapter/media 均从这里 import） */
export const WX_ITEM_TEXT = 1;
export const WX_ITEM_IMAGE = 2;
export const WX_ITEM_VOICE = 3;
export const WX_ITEM_FILE = 4;
export const WX_ITEM_VIDEO = 5;

const WX_MEDIA_ITEM_KEYS: Record<number, string> = {
  [WX_ITEM_IMAGE]: "image_item",
  [WX_ITEM_VOICE]: "voice_item",
  [WX_ITEM_FILE]: "file_item",
  [WX_ITEM_VIDEO]: "video_item",
};

export function isWeixinMediaItemType(type: unknown): boolean {
  return typeof type === "number" && type in WX_MEDIA_ITEM_KEYS;
}

/**
 * 提取引用消息中的媒体条目（ref_msg.message_item）。
 * 只做结构提取，下载交给调用方（计入每条消息 4 个附件上限）。
 */
export function referencedMediaItems(items: unknown): Array<{ item: any; title: string }> {
  if (!Array.isArray(items)) return [];
  const out: Array<{ item: any; title: string }> = [];
  for (const item of items) {
    const ref = (item as any)?.ref_msg;
    const refItem = ref?.message_item;
    if (!refItem || typeof refItem !== "object") continue;
    if (!isWeixinMediaItemType(refItem.type)) continue;
    out.push({ item: refItem, title: String(ref?.title ?? "").trim() });
  }
  return out;
}

/** 引用文本的展示（文本引用包含标题与正文；媒体引用标注类型） */
export function describeReference(refMsg: any): string | undefined {
  const refItem = refMsg?.message_item;
  const title = String(refMsg?.title ?? "").trim();
  if (!refItem || typeof refItem !== "object") {
    return title ? `[引用: ${title}]` : undefined;
  }
  if (isWeixinMediaItemType(refItem.type)) {
    const kind =
      refItem.type === WX_ITEM_IMAGE
        ? "图片"
        : refItem.type === WX_ITEM_VOICE
          ? "语音"
          : refItem.type === WX_ITEM_VIDEO
            ? "视频"
            : "文件";
    return `[引用${kind}${title ? `: ${title}` : ""}]`;
  }
  const text = String(refItem?.text_item?.text ?? "").trim();
  const label = title || text;
  return label ? `[引用: ${label}]` : undefined;
}

/** 语音条目的平台转写兜底（下载失败/无媒体时仍保留语义） */
export function voiceTranscript(item: any): string | undefined {
  if (item?.type !== WX_ITEM_VOICE) return undefined;
  const text = String(item?.voice_item?.text ?? "").trim();
  return text || undefined;
}
