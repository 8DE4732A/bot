import { describe, expect, test } from "bun:test";
import { evaluateChannelAccess } from "../src/channels/access-policy.ts";

const dm = (credentials: Record<string, unknown>, peerId = "p1") =>
  evaluateChannelAccess({ credentials, peerId, conversationType: "direct" });
const group = (credentials: Record<string, unknown>, peerId = "g1") =>
  evaluateChannelAccess({ credentials, peerId, conversationType: "group" });

describe("channel access policy", () => {
  test("旧配置兼容：allowFrom 非空 = 白名单，DM/群共用", () => {
    expect(dm({ allowFrom: ["p1"] }).allowed).toBe(true);
    expect(dm({ allowFrom: ["p2"] }).allowed).toBe(false);
    expect(group({ allowFrom: ["g1"] }).allowed).toBe(true);
    expect(group({ allowFrom: ["g2"] }).allowed).toBe(false);
    expect(dm({}).allowed).toBe(true);
    expect(group({}).allowed).toBe(true);
  });

  test("DM 策略矩阵", () => {
    expect(dm({ dmPolicy: "disabled", allowFrom: ["p1"] }).allowed).toBe(false);
    expect(dm({ dmPolicy: "open", allowFrom: ["other"] }).allowed).toBe(true);
    expect(dm({ dmPolicy: "allowlist", allowFrom: ["p1"] }).allowed).toBe(true);
    expect(dm({ dmPolicy: "allowlist", allowFrom: [] }).allowed).toBe(false);
    expect(dm({ dmPolicy: "allowlist", allowFrom: ["p2"] }).allowed).toBe(false);
  });

  test("群策略与 groupAllowFrom 独立于 DM 白名单", () => {
    const creds = {
      dmPolicy: "allowlist",
      allowFrom: ["user-1"],
      groupPolicy: "allowlist",
      groupAllowFrom: ["group-1"],
    };
    expect(dm(creds, "user-1").allowed).toBe(true);
    expect(dm(creds, "group-1").allowed).toBe(false);
    expect(group(creds, "group-1").allowed).toBe(true);
    expect(group(creds, "user-1").allowed).toBe(false);
    expect(group({ ...creds, groupPolicy: "disabled" }, "group-1").allowed).toBe(false);
    expect(group({ ...creds, groupPolicy: "open" }, "anything").allowed).toBe(true);
  });

  test("自动模式下 groupAllowFrom 优先于旧 allowFrom", () => {
    const creds = { allowFrom: ["legacy-peer"], groupAllowFrom: ["group-1"] };
    expect(group(creds, "group-1").allowed).toBe(true);
    expect(group(creds, "legacy-peer").allowed).toBe(false);
  });

  test("只匹配 peerId，不匹配昵称/senderId", () => {
    const verdict = dm({ dmPolicy: "allowlist", allowFrom: ["real-id"] });
    expect(verdict.allowed).toBe(false);
    const viaName = evaluateChannelAccess({
      credentials: { dmPolicy: "allowlist", allowFrom: ["real-id"] },
      peerId: "someone-else",
      senderId: "real-id",
      conversationType: "direct",
    });
    expect(viaName.allowed).toBe(false);
  });
});
