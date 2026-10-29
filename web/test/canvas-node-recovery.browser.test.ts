import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// Windows 下由 Node 承载 Vite 与 Playwright，避开 Bun 子进程管道的初始化挂起。
test("canvas node recovery browser acceptance", () => {
    const result = spawnSync("node", ["--experimental-strip-types", "--test", resolve(import.meta.dir, "fixtures/canvas-node-recovery-cases.ts")], {
        cwd: resolve(import.meta.dir, ".."), stdio: "inherit", timeout: 540_000, env: process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`恢复浏览器验收失败：${result.status}`);
}, 600_000);
