/* 广播输入的纯逻辑:组管理、本地行累积、危险命令判定与"扣回车"计划。
   UI 接线在 renderer-app 里测,这里只钉行为,不碰 DOM。 */
import { describe, expect, it } from "vitest";
import {
  CLEAR_LINE, createBroadcastState, isDangerousCommand, planWrite, removeFromBroadcast, toggleBroadcast,
} from "../../src/renderer/broadcast";

describe("危险命令判定", () => {
  it("命中:递归删除 / 格式化 / dd / 关机重启 / fork 炸弹", () => {
    for (const cmd of [
      "rm -rf /", "rm -fr /var", "rm -Rf build", "rm --recursive x",
      "mkfs.ext4 /dev/sdb1", "mkfs /dev/sdb1", "dd of=/dev/sda if=x",
      "shutdown -h now", "reboot", "halt", "poweroff", "init 0", ":(){ :|:& };:",
    ]) {
      expect(isDangerousCommand(cmd), cmd).toBe(true);
    }
  });

  it("不误伤:普通命令 / 非递归删除 / 只在参数里出现关键字", () => {
    for (const cmd of ["ls -la", "rm notes.txt", "rm -i a.txt", "echo rm -rf", "cat /etc/hosts", "df -h"]) {
      expect(isDangerousCommand(cmd), cmd).toBe(false);
    }
  });
});

describe("广播组管理", () => {
  it("加入/退出;退出时清掉本地行", () => {
    const st = createBroadcastState();
    expect(toggleBroadcast(st, 7)).toBe(true);
    expect([...st.ids]).toEqual([7]);
    st.lines.set(7, "abc");
    expect(toggleBroadcast(st, 7)).toBe(false);
    expect(st.ids.size).toBe(0);
    expect(st.lines.has(7)).toBe(false);
  });

  it("会话断开时移出;不在组里返回 false", () => {
    const st = createBroadcastState();
    toggleBroadcast(st, 1);
    expect(removeFromBroadcast(st, 1)).toBe(true);
    expect(removeFromBroadcast(st, 1)).toBe(false);
  });
});

describe("输入计划", () => {
  it("不在广播组:只发给自己,不做危险判断", () => {
    const st = createBroadcastState();
    expect(planWrite(st, 9, "rm -rf /")).toEqual({ targets: [9], confirm: null, clearOnDeny: false });
  });

  it("在组里打普通字符:发给全组并累积本地行", () => {
    const st = createBroadcastState();
    toggleBroadcast(st, 1);
    toggleBroadcast(st, 2);
    const plan = planWrite(st, 1, "ls");
    expect(plan.targets).toEqual([1, 2]);
    expect(plan.confirm).toBeNull();
    expect(st.lines.get(1)).toBe("ls");
  });

  it("退格删字符;方向键等控制字符重置本行(避免误判)", () => {
    const st = createBroadcastState();
    toggleBroadcast(st, 1);
    planWrite(st, 1, "abc");
    planWrite(st, 1, "\x7f");
    expect(st.lines.get(1)).toBe("ab");
    planWrite(st, 1, "\x1b[D");
    expect(st.lines.get(1)).toBe("");
  });

  it("Tab/\b/空行退格等边界:控制字符重置,退格在空行上不报错", () => {
    const st = createBroadcastState();
    toggleBroadcast(st, 1);
    planWrite(st, 1, "ab");
    planWrite(st, 1, "\t");              // Tab 视为控制字符 → 重置
    expect(st.lines.get(1)).toBe("");
    planWrite(st, 1, "\x7f");            // 空行上退格
    expect(st.lines.get(1)).toBe("");
    planWrite(st, 1, "a\x7fb");          // 退格删掉 a,再输入 b
    expect(st.lines.get(1)).toBe("b");
    planWrite(st, 1, "cd\nef");          // 块里的换行被跳过,不参与本行
    expect(st.lines.get(1)).toBe("bcdef");
  });

  it("回车:安全命令直接广播并清空本地行", () => {
    const st = createBroadcastState();
    toggleBroadcast(st, 1);
    toggleBroadcast(st, 2);
    planWrite(st, 1, "uptime");
    const plan = planWrite(st, 1, "\r");
    expect(plan).toEqual({ targets: [1, 2], confirm: null, clearOnDeny: false });
    expect(st.lines.get(1)).toBe("");
  });

  it("回车:危险命令扣住回车,等确认;拒绝时发 Ctrl+U 清行", () => {
    const st = createBroadcastState();
    toggleBroadcast(st, 1);
    toggleBroadcast(st, 2);
    planWrite(st, 1, "rm -rf /tmp/x");
    const plan = planWrite(st, 1, "\r");
    expect(plan.confirm).toEqual({ line: "rm -rf /tmp/x" });
    expect(plan.clearOnDeny).toBe(true);
    expect(plan.targets).toEqual([1, 2]);
    expect(st.lines.get(1)).toBe("");
    expect(CLEAR_LINE).toBe("\x15");
  });

  it("回车:空行不弹确认(直接广播)", () => {
    const st = createBroadcastState();
    toggleBroadcast(st, 1);
    expect(planWrite(st, 1, "\r").confirm).toBeNull();
  });

  it("换行符 \\n 也当回车处理", () => {
    const st = createBroadcastState();
    toggleBroadcast(st, 1);
    planWrite(st, 1, "reboot");
    expect(planWrite(st, 1, "\n").confirm).toEqual({ line: "reboot" });
  });
});
