import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp, type Launched } from "./launch";

let ctx: Launched;

test.beforeAll(async () => { ctx = await launchApp(); });
test.afterAll(async () => { await ctx?.close(); });

/* 共用一个应用实例(启动一次 ~1s,值得);所以每个用例开头把界面复位到 Vaults 屏,
   否则上一个用例停在 SFTP/设置面板会让后面的"工具条可见"类断言失真。 */
test.beforeEach(async () => {
  const { page } = ctx;
  await page.evaluate(() => {
    document.querySelectorAll(".prefs,.tab-menu,.menu,.form-backdrop,.discard-dlg").forEach((n) => n.remove());
  });
  await page.locator('#tabs .tab-btn[data-kind="vault"]').click();
  await expect(page.locator("#host-toolbar")).toBeVisible();
});

test("启动:窗口可用、默认停在 Vaults、语言跟随设置", async () => {
  const { page } = ctx;
  await expect(page.locator("#rail")).toBeVisible();
  await expect(page.locator("#host-search")).toBeVisible();
  const active = await page.locator("#tabs .tab-btn.active").getAttribute("data-kind");
  expect(active).toBe("vault");
  // 语言解析结果必须落到 <html lang>(zh-CN 或 en 之一)
  expect(await page.evaluate(() => document.documentElement.lang)).toMatch(/^(zh-CN|en)$/);
});

test("主机簿:新建 → 出现在列表 → 编辑 → 删除(并落盘到临时 userData)", async () => {
  const { page, userData } = ctx;
  const name = `e2e-${Date.now()}`;

  await page.locator("#btn-new-host").click();
  await expect(page.locator("#host-form")).toBeVisible();
  await page.locator("#f-name").fill(name);
  await page.locator("#f-host").fill("10.9.9.9");
  await page.locator("#f-username").fill("tester");
  await page.locator("#f-auth").selectOption("password");
  await page.locator("#btn-save").click();

  const card = page.locator("#host-list .host-item", { hasText: name });
  await expect(card).toBeVisible();

  // 落盘:临时 userData 下的 hosts.json 应该真的写进去了
  /* 落盘:真实结构是 { version, hosts: [...] },并且用 tmp+rename 原子写。
     轮询到"新主机出现在 hosts 里"为止(不读一次就断言,避免撞上写入瞬间)。 */
  const hostsFile = path.join(userData, "hosts.json");
  await expect.poll(() => {
    try {
      const raw = JSON.parse(fs.readFileSync(hostsFile, "utf8")) as { hosts?: Array<Record<string, unknown>> };
      return (raw.hosts ?? []).some((h) => String(h.name ?? "") === name);
    } catch { return false; }
  }, { message: `hosts.json 应包含 ${name}`, timeout: 15_000 }).toBe(true);

  // 编辑:改名字(卡片上的 ✎/✕ 是 hover 才显形的,与原版一致 —— 必须先把鼠标移上去)
  await card.hover();
  await expect(card.locator("[data-act=edit]").first()).toBeVisible();
  await card.locator("[data-act=edit]").first().click();
  await expect(page.locator("#host-form")).toBeVisible();
  await page.locator("#f-name").fill(`${name}-renamed`);
  await page.locator("#btn-save").click();
  await expect(page.locator("#host-list .host-item", { hasText: `${name}-renamed` })).toBeVisible();

  // 删除(同样先 hover):会先弹出应用自己的确认框,确认后才消失
  const renamed = page.locator("#host-list .host-item", { hasText: `${name}-renamed` });
  await renamed.hover();
  await renamed.locator("[data-act=del]").first().click();

  const confirmDlg = page.locator(".discard-dlg");
  await expect(confirmDlg).toBeVisible();
  await expect(confirmDlg.locator(".dd-body p")).toContainText(`${name}-renamed`);
  await confirmDlg.locator(".dd-ok").click();
  await expect(page.locator("#host-list .host-item", { hasText: `${name}-renamed` })).toHaveCount(0);
});

test("设置:⌘, 打开面板;切换语言后侧栏文案随之变化;切回中文", async () => {
  const { page } = ctx;
  await page.evaluate(() => document.querySelectorAll(".prefs").forEach((n) => n.remove()));
  await page.keyboard.press("Meta+,");
  await expect(page.locator(".prefs")).toBeVisible();

  const initialLabel = await page.locator(".rail-item .rl").first().textContent();
  await page.locator('.prefs .lang-mode[data-lang="en"]').click();
  await expect(page.locator(".rail-item .rl").first()).toHaveText("Hosts");
  // 面板自身也要跟着变(本轮修的 bug)
  await expect(page.locator(".prefs h4").first()).toHaveText("Interface");

  await page.locator('.prefs .lang-mode[data-lang="zh"]').click();
  // 切回中文后必须是中文标签(与初始语言无关:CI 上系统是 en,初始标签为 Hosts)
  await expect(page.locator(".rail-item .rl").first()).toHaveText("主机");
  void initialLabel;
});

test("外观:深浅色切换与字号调节写进 localStorage", async () => {
  const { page } = ctx;
  /* 旧主机页齿轮已移除:外观入口走顶栏偏好设置按钮(⌘, 同一路径) */
  await page.locator("#btn-prefs").click();
  await expect(page.locator(".prefs")).toBeVisible();

  await page.locator('.prefs .ui-mode[data-mode="light"]').click();
  await expect.poll(() => page.evaluate(() => document.body.dataset.ui)).toBe("light");
  await page.locator('.prefs .ui-mode[data-mode="dark"]').click();
  await expect.poll(() => page.evaluate(() => document.body.dataset.ui)).toBe("dark");

  const before = await page.evaluate(() => Number(localStorage.getItem("sshkit.fontSize") ?? 0));
  await page.locator(".prefs .ps-up").click();
  await expect.poll(() => page.evaluate(() => Number(localStorage.getItem("sshkit.fontSize") ?? 0)))
    .toBeGreaterThan(before);
});

test("SFTP:本地栏列出真实目录内容,远端栏在无会话时是空态而不是错误", async () => {
  const { page } = ctx;
  await page.locator("#tabs .tab-btn[data-kind=sftp]").click();
  const local = page.locator('.sftp-pane[data-which="local"]');
  await expect(local.locator(".sp-row").first()).toBeVisible();
  await expect(local.locator(".sp-row")).not.toHaveCount(0);

  const remote = page.locator('.sftp-pane[data-which="remote"]');
  await expect(remote.locator(".sftp-empty:not(.sftp-err)")).toBeVisible();
});

test("标签页:会话标签可新建(本地 shell 落地页),关闭后消失", async () => {
  const { page } = ctx;
  const before = await page.locator("#tabs .tab-btn").count();
  await page.locator("#btn-new-tab").click();
  await expect.poll(() => page.locator("#tabs .tab-btn").count()).toBeGreaterThan(before);
  const extra = page.locator("#tabs .tab-btn").last();
  await extra.locator(".tab-close").first().click();   // 真实类名:tab-close
  await expect.poll(() => page.locator("#tabs .tab-btn").count()).toBe(before);
});

test("回归:主机页搜索框与工具条左缘对齐,Connect 距框右缘 8px(不再双重缩进)", async () => {
  /* 这个 bug 只在真实布局里看得见:jsdom 没有排版,单测断言不到。
     #host-tools 曾经自带 padding:0 10px,而父容器 .sec-band 已有 10px → 输入框被推到
     205(原版实测 194),与下方工具条(195)错位。这里锁"两者左缘相等" + Connect 内边距。 */
  const { page } = ctx;
  const g = await page.evaluate(() => {
    const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
    return {
      searchLeft: box("#host-search").left,
      toolbarLeft: box("#host-toolbar").left,
      searchRight: box("#host-search").right,
      connectRight: box("#btn-connect").right,
    };
  });
  expect(g.searchLeft).toBe(g.toolbarLeft);
  expect(g.searchRight - g.connectRight).toBe(8);
});
