import { describe, expect, test } from "bun:test";
import {
  getChannelType,
  listChannelTypes,
  listPublicChannelTypes,
  registerChannelType,
} from "../src/channels/registry.ts";
import {
  CREDENTIAL_MASK,
  maskChannelCredentials,
  normalizeChannelCredentials,
  validateRequiredCredentials,
} from "../src/channels/credentials.ts";
import type { ChannelTypeDescriptor } from "../src/channels/descriptor.ts";

const fakeDescriptor: ChannelTypeDescriptor = {
  type: "fake-test",
  label: "Fake",
  description: "test",
  managedBy: "manager",
  creatable: true,
  deletable: true,
  credentials: [
    { key: "token", label: "Token", type: "secret", required: true },
    { key: "label", label: "Label", type: "string" },
    { key: "enabled", label: "Enabled", type: "boolean" },
    { key: "peer", label: "Peer", type: "list", maxItems: 2 },
    { key: "mode", label: "Mode", type: "select", options: [{ value: "a", label: "A" }] },
  ],
  capabilities: {
    groupChat: true,
    mediaInbound: [],
    mediaOutbound: [],
    passiveReply: false,
    typing: false,
    streaming: false,
    markdown: "plain",
    maxMessageBytes: 4_000,
  },
};

describe("channel registry", () => {
  test("内置类型齐全且 public 序列化不含函数", () => {
    const types = listChannelTypes().map((t) => t.type);
    expect(types).toEqual(
      expect.arrayContaining(["feishu", "wecom", "qq", "weixin", "telegram", "terminal"]),
    );
    for (const pub of listPublicChannelTypes()) {
      expect(pub).not.toHaveProperty("create");
      expect(pub).not.toHaveProperty("validate");
      expect(pub).not.toHaveProperty("onDelete");
      expect(JSON.stringify(pub)).not.toContain("create");
    }
    const weixin = listPublicChannelTypes().find((t) => t.type === "weixin")!;
    expect(weixin.auth?.kind).toBe("qr");
    expect(weixin.auth).not.toHaveProperty("start");
    expect(weixin.capabilities.mediaOutbound.length).toBeGreaterThan(0);
    expect(getChannelType("terminal")?.managedBy).toBe("cli");
  });

  test("重复注册抛错；测试可注销", () => {
    const dispose = registerChannelType(fakeDescriptor);
    expect(getChannelType("fake-test")).toBe(fakeDescriptor);
    expect(() => registerChannelType(fakeDescriptor)).toThrow(/duplicate/);
    dispose();
    expect(getChannelType("fake-test")).toBeUndefined();
  });
});

describe("channel credentials", () => {
  test("mask 只隐藏 secret，保留普通字符串", () => {
    const masked = maskChannelCredentials(fakeDescriptor, {
      token: "secret-value",
      label: "visible",
      enabled: true,
      peer: ["a"],
      unknown: "legacy-secret",
    });
    expect(masked.token).toBe(CREDENTIAL_MASK);
    expect(masked.label).toBe("visible");
    expect(masked.enabled).toBe(true);
    expect(masked.peer).toEqual(["a"]);
    // 未声明字符串按 secret 保守处理
    expect(masked.unknown).toBe(CREDENTIAL_MASK);
  });

  test("secret 空值/掩码保留旧值；普通字段可清空；list/boolean/select 归一化", () => {
    const previous = { token: "old-token", label: "old", enabled: true, peer: ["x"] };
    const merged = normalizeChannelCredentials(
      fakeDescriptor,
      {
        token: CREDENTIAL_MASK,
        label: "",
        enabled: "false",
        peer: "a, b, c",
        mode: "a",
        extra: "kept",
      },
      previous,
    );
    expect(merged.token).toBe("old-token");
    expect(merged.label).toBeUndefined();
    expect(merged.enabled).toBe(false);
    expect(merged.peer).toEqual(["a", "b"]);
    expect(merged.mode).toBe("a");
    expect(merged.extra).toBe("kept");
    expect(previous.token).toBe("old-token");
  });

  test("secret 提交空字符串保旧；非法 select 抛错", () => {
    const merged = normalizeChannelCredentials(fakeDescriptor, { token: "" }, { token: "old" });
    expect(merged.token).toBe("old");
    expect(() =>
      normalizeChannelCredentials(fakeDescriptor, { mode: "bad" }, {}),
    ).toThrow(/invalid value/);
  });

  test("必填校验", () => {
    expect(validateRequiredCredentials(fakeDescriptor, {})).toMatch(/Token is required/);
    expect(validateRequiredCredentials(fakeDescriptor, { token: "x" })).toBeUndefined();
  });
});
