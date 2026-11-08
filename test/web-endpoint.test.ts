import { afterEach, describe, expect, test } from "bun:test";
import {
  clearRuntimeWebEndpoint,
  configuredWebEndpoint,
  connectableHost,
  formatHostForUrl,
  formatWebUrl,
  resolveWebEndpoint,
  runtimeOrConfiguredWebEndpoint,
  setRuntimeWebEndpoint,
} from "../src/config/web-endpoint.ts";

const CONFIGURED = { host: "127.0.0.1", port: 3000 };

describe("web endpoint", () => {
  afterEach(() => clearRuntimeWebEndpoint());

  test("通配地址回退回环，IPv6 字面量加方括号", () => {
    expect(connectableHost("0.0.0.0")).toBe("127.0.0.1");
    expect(connectableHost("::")).toBe("127.0.0.1");
    expect(connectableHost("[::]")).toBe("127.0.0.1");
    expect(connectableHost(" 192.168.1.5 ")).toBe("192.168.1.5");
    expect(formatHostForUrl("::1")).toBe("[::1]");
    expect(formatHostForUrl("[::1]")).toBe("[::1]");
    expect(formatWebUrl({ host: "0.0.0.0", port: 34567 })).toBe("http://127.0.0.1:34567");
    expect(formatWebUrl({ host: "::1", port: 34567 })).toBe("http://[::1]:34567");
  });

  test("控制 socket 的实际端点优先于数据库配置", () => {
    expect(resolveWebEndpoint({ webHost: "0.0.0.0", webPort: "34567" }, CONFIGURED)).toEqual({
      host: "127.0.0.1",
      port: 34567,
    });
    expect(resolveWebEndpoint({ webHost: "192.168.1.5", webPort: 34568 }, CONFIGURED)).toEqual({
      host: "192.168.1.5",
      port: 34568,
    });
  });

  test("旧 gateway 缺字段或端口非法时回退配置", () => {
    expect(resolveWebEndpoint(undefined, CONFIGURED)).toEqual(CONFIGURED);
    expect(resolveWebEndpoint({ webPort: "abc" }, CONFIGURED)).toEqual(CONFIGURED);
    expect(resolveWebEndpoint({ webHost: "", webPort: 70_000 }, CONFIGURED)).toEqual(CONFIGURED);
    expect(resolveWebEndpoint({ webHost: "10.0.0.2", webPort: -1 }, CONFIGURED)).toEqual({
      host: "10.0.0.2",
      port: 3000,
    });
  });

  test("configuredWebEndpoint 解析数据库值并兜底非法端口", () => {
    const values: Record<string, string> = { web_host: "0.0.0.0", web_port: "34567" };
    const store = { getConfig: (key: string, fallback = "") => values[key] ?? fallback };
    expect(configuredWebEndpoint(store)).toEqual({ host: "0.0.0.0", port: 34567 });
    expect(configuredWebEndpoint({ getConfig: () => "nope" })).toEqual({ host: "nope", port: 3000 });
  });

  test("运行期端点覆盖配置且返回副本", () => {
    const input = { host: "0.0.0.0", port: 34567 };
    setRuntimeWebEndpoint(input);
    input.port = 1;

    const first = runtimeOrConfiguredWebEndpoint({ getConfig: () => "3000" });
    expect(first).toEqual({ host: "0.0.0.0", port: 34567 });
    first.port = 2;
    expect(runtimeOrConfiguredWebEndpoint({ getConfig: () => "3000" })).toEqual({
      host: "0.0.0.0",
      port: 34567,
    });
  });
});
