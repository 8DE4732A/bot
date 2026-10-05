import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { safeFetch } from "../../utils/net-guard.ts";

const fetchUrlTool = defineTool({
  name: "fetch_url",
  description: "Fetch web content from a given URL via HTTP/HTTPS request.",
  parameters: Type.Object({
    url: Type.String({ description: "The full URL to fetch" }),
    maxBytes: Type.Optional(Type.Number({ description: "Maximum bytes to return (default 32KB)" })),
  }),
  async execute(args, api) {
    try {
      // SSRF 防线: bash 沙盒的网络白名单不覆盖宿主进程内 fetch, 此处统一收紧
      const response = await safeFetch(args.url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; BotAgent/1.0)",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      // 流式读取并在 maxBytes 处主动中止, 防止超大响应把宿主进程 OOM
      const limit = args.maxBytes ?? 32768;
      let text = "";
      const reader = response.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        try {
          while (text.length < limit) {
            const { done, value } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      }
      const truncated = text.length > limit ? text.slice(0, limit) + "\n...[truncated]" : text;

      return {
        content: [
          {
            type: "text",
            text: truncated,
          },
        ],
      };
    } catch (err: any) {
      throw new Error(`Failed to fetch URL ${args.url}: ${err?.message || err}`);
    }
  },
});

const searchWebTool = defineTool({
  name: "search_web",
  description: "Search the web using DuckDuckGo Instant Answer API.",
  parameters: Type.Object({
    query: Type.String({ description: "The search query" }),
  }),
  async execute(args) {
    try {
      const searchUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(args.query)}&format=json&no_html=1&skip_disambig=1`;
      const response = await fetch(searchUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as any;
      const abstract = data.AbstractText || data.Abstract || "";
      const related = (data.RelatedTopics || [])
        .slice(0, 5)
        .map((t: any) => t.Text)
        .filter(Boolean)
        .join("\n- ");

      const result = [
        abstract ? `Summary:\n${abstract}` : "",
        related ? `Related Points:\n- ${related}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: result || `No immediate summary found for query: ${args.query}`,
          },
        ],
      };
    } catch (err: any) {
      throw new Error(`Search failed: ${err?.message || err}`);
    }
  },
});

export const WebSearchTools = defineExtension({
  name: "web-search",
  tools: [fetchUrlTool, searchWebTool],
});
