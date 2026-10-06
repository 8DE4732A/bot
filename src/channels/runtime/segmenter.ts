/**
 * 出站分段 (对齐 hermes base.py 的 UTF 安全分段 + greedy_pack_blocks):
 * 按 maxMessageBytes (UTF-8 字节) 切分。
 * 策略 = 块级贪心打包:
 * 1. 内容按空行切块, ```/~~~ 围栏块整体不可切 (闭围栏须同字符且长度 ≥ 开围栏,
 *    嵌套围栏不误关); 空行本身保留, 重组无损;
 * 2. 块贪心装入 ≤ maxBytes 的段;
 * 3. 单块超限时才动手术——围栏块切开后逐段闭合/重开围栏,
 *    普通块按行/码点边界硬切 (UTF-8 安全, 不劈多字节字符/代理对)。
 * 段数上限由调用方 (deliverOutbound) 施加, 本模块保持纯函数语义。
 */

export interface SplitOptions {
  /** 单条消息字节上限 */
  maxBytes: number;
}

const CODE_FENCE = "```";
const FENCE_EDGE_BYTES = 4;

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function fenceOf(line: string): { char: string; len: number } | null {
  const m = line.match(/^\s*(`{3,}|~{3,})/);
  return m ? { char: m[1][0], len: m[1].length } : null;
}

/** 按码点安全截取前 maxBytes 字节 (O(n), 不劈多字节字符/代理对) */
function truncateAtByteBoundary(s: string, maxBytes: number): string {
  if (byteLength(s) <= maxBytes) return s;
  const buf = Buffer.from(s, "utf8");
  let cut = Math.min(maxBytes, buf.length);
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return buf.subarray(0, cut).toString("utf8");
}

/** 按码点切出第一个字符 (预算 < 首字符字节数时的最小进度保证, 防硬切死循环) */
function firstCodePoint(s: string): string {
  return String.fromCodePoint(s.codePointAt(0)!);
}

/**
 * 内容按空行切块; 围栏块自开 fence 起到闭 fence (同字符且长度 ≥ 开围栏,
 * 或文本末尾) 为一个块。块按原顺序拼接后与原文等价 (空行作为前块的尾行保留)。
 */
function splitBlocks(content: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  let fenceChar = "`";
  let fenceLen = 3;

  const flush = (suffix = "") => {
    if (current.length > 0) blocks.push(current.join("\n") + suffix);
    current = [];
  };

  for (const line of content.split("\n")) {
    const fence = fenceOf(line);
    if (fence) {
      if (!inFence) {
        flush();
        inFence = true;
        fenceChar = fence.char;
        fenceLen = fence.len;
        current = [line];
        continue;
      }
      if (fence.char === fenceChar && fence.len >= fenceLen) {
        // 闭围栏: 围栏块结束
        current.push(line);
        flush();
        inFence = false;
        continue;
      }
      // 围栏内的类围栏行 (嵌套/弱标记): 内容
      current.push(line);
      continue;
    }
    if (!inFence && line.trim() === "") {
      // 空行收束当前块, 空行本身作为前块尾部保留 (重组无损)
      current.push(line);
      flush("\n");
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks.filter((b) => b.length > 0);
}

/** 围栏块切开: 逐段闭合/重开围栏, 每段独立成立 */
function splitFencedBlock(block: string, maxBytes: number): string[] {
  const lines = block.split("\n");
  const open = lines[0];
  // 中间段闭合用与开围栏同字符同长度的标记 (```` 须闭 ````, ~~~ 闭 ~~~;
  // 更短的 ``` 不能闭合更长的围栏, ~~~ 更不能)
  const openMarker = open.match(/^\s*(`{3,}|~{3,})/)?.[1] ?? CODE_FENCE;
  const hasClose = lines.length > 1 && fenceOf(lines[lines.length - 1]) !== null;
  const close = hasClose ? lines[lines.length - 1] : "";
  const bodyLines = lines.slice(1, hasClose ? -1 : undefined);
  // body 预算 = 上限 - 开围栏行 - 分隔"\n" - 闭合"\n"+标记
  // (两个 \n 都要减: emit 输出 = open + "\n" + part + "\n" + openMarker)
  const budget = Math.max(1, maxBytes - byteLength(open) - byteLength("\n\n" + openMarker));

  const out: string[] = [];
  let buf = "";
  // 中间段一律用 openMarker 闭合; 末段由调用方按 hasClose 处理
  const emit = (bodyPart: string) => {
    out.push(open + "\n" + bodyPart + "\n" + openMarker);
  };
  for (const line of bodyLines) {
    const candidate = buf ? buf + "\n" + line : line;
    if (byteLength(candidate) <= budget) {
      buf = candidate;
      continue;
    }
    if (buf) emit(buf);
    if (byteLength(line) > budget) {
      let rest = line;
      while (byteLength(rest) > budget) {
        // 预算小于首字符字节数时截断为空串 → 码点保底切一个字符 (净前进防死循环)
        const part = truncateAtByteBoundary(rest, budget) || firstCodePoint(rest);
        rest = rest.slice(part.length);
        emit(part);
      }
      buf = rest;
    } else {
      buf = line;
    }
  }
  if (buf) {
    // 末段: 有闭围栏用原样闭围栏; 无闭围栏保持原文未闭合状态
    out.push(hasClose ? open + "\n" + buf + "\n" + close : open + "\n" + buf);
  }
  return out;
}

/** 普通块切开: 按行打包; 单行超限按码点边界硬切 */
function splitPlainBlock(block: string, maxBytes: number): string[] {
  const out: string[] = [];
  let buf = "";
  const pushLine = (line: string) => {
    if (byteLength(line) > maxBytes) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      let rest = line;
      while (byteLength(rest) > maxBytes) {
        const part = truncateAtByteBoundary(rest, maxBytes) || firstCodePoint(rest);
        rest = rest.slice(part.length);
        out.push(part);
      }
      buf = rest;
      return;
    }
    const candidate = buf ? buf + "\n" + line : line;
    if (byteLength(candidate) > maxBytes) {
      out.push(buf);
      buf = line;
    } else {
      buf = candidate;
    }
  };
  for (const line of block.split("\n")) pushLine(line);
  if (buf.length > 0) out.push(buf);
  return out;
}

/**
 * 把 content 切成若干条 ≤ maxBytes 的消息。
 * maxBytes 缺省/超限时返回单段。
 */
export function splitMessage(content: string, maxBytes?: number): string[] {
  if (!maxBytes || maxBytes <= 0 || byteLength(content) <= maxBytes) return [content];

  const chunks: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf.trim().length > 0) chunks.push(buf);
    buf = "";
  };

  for (const block of splitBlocks(content)) {
    if (byteLength(block) > maxBytes) {
      flush();
      const pieces = fenceOf(block) ? splitFencedBlock(block, maxBytes) : splitPlainBlock(block, maxBytes);
      chunks.push(...pieces);
      continue;
    }
    if (byteLength(buf + block) > maxBytes) flush();
    buf += block;
  }
  flush();
  return chunks.filter((c) => c.trim().length > 0);
}
