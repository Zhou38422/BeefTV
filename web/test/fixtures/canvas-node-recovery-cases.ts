import { after as afterAll, before as beforeAll, beforeEach, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { createServer as createNetServer } from "node:net";
import type { GenerationTask } from "../../src/services/api/task-center.ts";

const testDir = resolve(import.meta.dirname, "..");
let server: ViteDevServer;
let browser: Browser;
let page: Page;
let origin: string;
let state: "uncertain" | "running" | "succeeded" | "failed" | "query-error" | "provider-error" | "paused" | "provider-success" | "missing-upstream";
let reads: number;
let providerQueries: number;
let retries: number;
let creates: number;
let gate: Promise<void> | undefined;
let release: (() => void) | undefined;
const errors: string[] = [];
const unexpectedWrites: string[] = [];
const shots = resolve(testDir, "../../output/canvas-node-recovery");

function task(): GenerationTask {
    const status = state === "running" ? "running" : state === "succeeded" || state === "paused" ? "succeeded" : "failed";
    const outcome: GenerationTask["outcome"] = state === "failed"
        ? { phase: "failed", regenerate: "allowed", reason: "not_charged" }
        : state === "running" ? { phase: "running", regenerate: "blocked", reason: "task_running" }
        : state === "succeeded" ? { phase: "ready", regenerate: "allowed", reason: "result_ready" }
        : { phase: "retrievable", regenerate: "blocked", reason: state === "paused" ? "delivery_pending" : "submission_unknown" };
    return { id: "original-task", type: "canvas_video", projectId: "original-canvas", status, outcome, stage: state === "running" ? "generating" : state === "succeeded" ? "completed" : state === "paused" ? "delivery_paused" : state === "failed" ? "任务失败" : "submission_unknown", errorCode: state === "failed" ? "request_not_sent" : status === "failed" ? "submission_uncertain" : undefined, error: state === "failed" ? "未能连接服务，本次请求尚未提交。请检查网络或代理后重试。" : undefined, providerRequestId: "provider-original", progress: status === "running" ? 42 : status === "succeeded" ? 100 : 0, attempts: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}
const snapshot = () => page.evaluate(() => (window as any).__recovery.snapshot());
async function waitStatus(status: string) {
    await page.waitForFunction(value => (window as any).__recovery?.snapshot().nodes[0]?.metadata?.status === value, status);
}
async function screenshot(name: string) {
    await page.screenshot({ path: resolve(shots, name), fullPage: true, animations: "disabled" });
}
async function open(theme = "light") {
    await page.goto(`${origin}/__recovery?theme=${theme}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.getByTestId("harness").waitFor().catch(async error => {
        throw new Error(`验收页面未就绪：${JSON.stringify(errors)}；${(await page.locator("body").innerText()).slice(0, 1000)}`, { cause: error });
    });
    await page.getByRole("button", { name: "查询并恢复" }).waitFor();
}

beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    const reservation = createNetServer();
    await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    server = await createServer({
        configFile: resolve(testDir, "../vite.config.ts"), logLevel: "error",
        optimizeDeps: { entries: [resolve(testDir, "fixtures/canvas-node-recovery-harness.tsx")] },
        server: { host: "127.0.0.1", port, strictPort: true, open: false },
        plugins: [{ name: "recovery-acceptance-page", configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
                if (!request.url?.startsWith("/__recovery")) return next();
                const html = await vite.transformIndexHtml(request.url, '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>原节点恢复验收</title></head><body><div id="root"></div><script type="module" src="/test/fixtures/canvas-node-recovery-harness.tsx"></script></body></html>');
                response.setHeader("Content-Type", "text/html"); response.end(html);
            });
        } }],
    });
    await server.listen();
    origin = `http://127.0.0.1:${port}`;
    const executablePath = process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : undefined;
    browser = await chromium.launch({ headless: true, executablePath });
}, { timeout: 120_000 });

beforeEach(async () => {
    release?.();
    await page?.close();
    state = "uncertain";
    reads = providerQueries = retries = creates = 0;
    gate = undefined;
    release = undefined;
    errors.length = unexpectedWrites.length = 0;
    page = await browser.newPage({ viewport: { width: 1280, height: 840 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(45_000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ code: status === 200 ? 0 : status, data, msg: status === 200 ? "ok" : "模拟查询失败，请稍后重试" }) });
        if (url.pathname === "/mock-result.mp4") return route.fulfill({ path: resolve(testDir, "../../assets/readme/beeftv-agent-drama-shot-4-web.mp4"), contentType: "video/mp4" });
        if (!url.pathname.startsWith("/api/")) return route.continue();
        if (url.pathname === "/api/tasks" && request.method() === "POST") { creates++; return json(null, 500); }
        if (url.pathname === "/api/tasks/original-task" && request.method() === "GET") {
            reads++;
            if (gate) await gate;
            if (state === "query-error") return json(null, 503);
            return json({ ...task(), ...(state === "missing-upstream" ? { providerRequestId: undefined } : {}) });
        }
        if (url.pathname === "/api/tasks/original-task/recover") {
            providerQueries++;
            if (gate) await gate;
            if (state === "provider-error") return json(null, 409);
            if (state === "paused") state = "succeeded";
            if (state === "provider-success") { state = "succeeded"; return json(task()); }
            return json(task());
        }
        if (url.pathname === "/api/tasks/original-task/retry") {
            retries++;
            state = state === "paused" ? "succeeded" : "running";
            return json(task());
        }
        if (request.method() !== "GET") unexpectedWrites.push(`${request.method()} ${url.pathname}`);
        return json([]);
    });
});

afterEach(() => { assert.deepEqual(unexpectedWrites, []); assert.deepEqual(errors, []); });

afterAll(async () => {
    release?.();
    await browser?.close();
    await server?.close();
}, { timeout: 30_000 });

test("uncertain → querying → running → success preserves the original node and plays its result", { timeout: 120_000 }, async () => {
    await open();
    await screenshot("01-uncertain-light.png");
    gate = new Promise(resolve => { release = resolve; });
    await page.getByRole("button", { name: "查询并恢复" }).click();
    await waitStatus("loading");
    await screenshot("02-querying-light.png");
    state = "running";
    release!(); gate = undefined;
    await page.waitForFunction(() => (window as any).__recovery.snapshot().nodes[0].metadata.taskStage === "generating");
    await screenshot("03-running-light.png");
    state = "succeeded";
    await waitStatus("success");
    await page.getByRole("button", { name: "播放 镜头 01 · 雨夜街道", exact: true }).waitFor();
    await page.getByRole("button", { name: "播放 镜头 01 · 雨夜街道", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll("video")].some(video => video.readyState >= 2));
    await page.evaluate(() => document.querySelector("video")?.pause());
    await screenshot("04-recovered-light.png");
    const current = await snapshot();
    assert.equal((current.nodes).length, 1);
    assert.equal(current.nodes[0].id, "original-node");
    assert.deepEqual(current.nodes[0].position, { x: 0, y: 0 });
    assert.equal(current.applies, 1);
    assert.equal(retries, 0); assert.equal(creates, 0); assert.deepEqual(errors, []);
});

test("confirmed unsent failure → retry on the same node → success", { timeout: 120_000 }, async () => {
    state = "failed";
    await open();
    await page.getByRole("button", { name: "查询并恢复" }).click();
    await page.getByRole("button", { name: "重新生成", exact: true }).waitFor();
    await screenshot("05-confirmed-failure-light.png");
    assert.equal(retries, 0);
    await page.getByRole("button", { name: "重新生成", exact: true }).click();
    await waitStatus("loading");
    state = "succeeded";
    await waitStatus("success");
    assert.equal(retries, 1); assert.equal(creates, 0);
    assert.equal((await snapshot()).nodes[0].id, "original-node");
});

test("upstream still uncertain keeps paid retry blocked in the dark theme", { timeout: 120_000 }, async () => {
    await open("dark");
    await screenshot("06-uncertain-dark.png");
    await page.getByRole("button", { name: "查询并恢复" }).focus();
    await page.keyboard.press("Enter");
    await waitStatus("error");
    assert.equal((await snapshot()).nodes[0].metadata.taskStage, "submission_unknown");
    await screenshot("07-still-uncertain-dark.png");
    assert.equal(await page.getByRole("button", { name: "重新生成", exact: true }).count(), 0);
    assert.equal(providerQueries, 1); assert.equal(retries, 0); assert.equal(creates, 0);
});

test("query failure restores a usable recovery button without claiming a saved result", { timeout: 120_000 }, async () => {
    state = "query-error";
    await open();
    await page.getByRole("button", { name: "查询并恢复" }).click();
    await waitStatus("error");
    await screenshot("08-query-failed-light.png");
    assert.equal(await page.getByRole("button", { name: "查询并恢复" }).isVisible(), true);
    assert.equal(await page.getByRole("button", { name: "继续取回", exact: true }).count(), 0);
    assert.equal((await snapshot()).applies, 0);
    assert.equal(creates, 0);
});

test("result application failure keeps the existing result recoverable", { timeout: 120_000 }, async () => {
    state = "succeeded";
    await open();
    await page.evaluate(() => (window as any).__recovery.setApplyFails(true));
    await page.getByRole("button", { name: "查询并恢复" }).click();
    await page.getByRole("button", { name: "继续取回", exact: true }).waitFor();
    await screenshot("09-apply-failed-light.png");
    await page.evaluate(() => (window as any).__recovery.setApplyFails(false));
    await page.getByRole("button", { name: "继续取回", exact: true }).click();
    await waitStatus("success");
    assert.equal(retries, 0); assert.equal(creates, 0);
});

test("duplicate clicks share a single recovery and stale replies cannot write after ownership changes", { timeout: 120_000 }, async () => {
    for (const action of ["switchCanvas", "switchAccount", "replaceTask", "removeNode"] as const) {
        state = "succeeded";
        await open();
        gate = new Promise(resolve => { release = resolve; });
        const before = reads;
        const requestStarted = page.waitForRequest(request => request.url().endsWith("/api/tasks/original-task"));
        await page.evaluate(() => (window as any).__recovery.recoverTwice());
        await waitStatus("loading");
        await requestStarted;
        await page.evaluate(name => (window as any).__recovery[name](), action);
        release!(); gate = undefined;
        await page.evaluate(async () => { await (window as any).__recoveryPending; });
        assert.equal(reads - before, 1);
        assert.equal((await snapshot()).applies, 0);
        assert.equal(creates, 0);
        await page.reload();
    }
});

test("existing upstream success is queried and applied without a generation retry", { timeout: 120_000 }, async () => {
    state = "provider-success";
    await open();
    await page.getByRole("button", { name: "查询并恢复" }).click();
    await waitStatus("success");
    assert.equal(providerQueries, 1); assert.equal(retries, 0); assert.equal(creates, 0);
    assert.equal((await snapshot()).applies, 1);
});

test("provider query conflicts and missing upstream IDs preserve uncertainty", { timeout: 120_000 }, async () => {
    for (const next of ["provider-error", "missing-upstream"] as const) {
        state = next;
        await open();
        const before = providerQueries;
        await page.getByRole("button", { name: "查询并恢复" }).click();
        await page.evaluate(async () => { await (window as any).__recoveryPending; });
        await waitStatus("error");
        assert.equal(providerQueries - before, 1);
        assert.equal(await page.getByRole("button", { name: "查询并恢复" }).isVisible(), true);
        assert.equal(await page.getByRole("button", { name: "重新生成", exact: true }).count(), 0);
        assert.equal(retries, 0); assert.equal(creates, 0);
        await page.reload();
    }
});

test("paused delivery resumes retrieval of the same task", { timeout: 120_000 }, async () => {
    state = "paused";
    await open();
    await page.getByRole("button", { name: "查询并恢复" }).click();
    await waitStatus("success");
    assert.equal(providerQueries, 1); assert.equal(retries, 0); assert.equal(creates, 0);
    assert.equal((await snapshot()).nodes[0].metadata.taskId, "original-task");
});

test("original task details remain accessible without initiating recovery", { timeout: 120_000 }, async () => {
    await open();
    await page.getByRole("button", { name: "查看原任务" }).click();
    await page.getByRole("dialog", { name: "原任务详情" }).waitFor();
    await screenshot("10-original-task-details.png");
    assert.equal(reads, 0); assert.equal(providerQueries, 0); assert.equal(creates, 0);
});

async function darkScreenshot(name: string) {
    const canvas = page.getByTestId("canvas");
    assert.equal(await page.locator("html.dark").count(), 1);
    await canvas.screenshot({ path: resolve(shots, `dark-${name}.png`), animations: "disabled" });
}

test("dark canvas recovery flow has distinct querying, generation and playable success states", { timeout: 120_000 }, async () => {
    await open("dark");
    await darkScreenshot("01-uncertain");
    gate = new Promise(resolve => { release = resolve; });
    await page.getByRole("button", { name: "查询并恢复" }).click();
    await page.getByRole("status", { name: "正在查询原任务", exact: true }).waitFor();
    await darkScreenshot("02-querying");
    assert.equal(await page.getByRole("button", { name: "重新生成", exact: true }).count(), 0);
    state = "running"; release!(); gate = undefined;
    await page.waitForFunction(() => (window as any).__recovery.snapshot().nodes[0].metadata.taskStage === "generating");
    await page.getByText("42%", { exact: true }).waitFor();
    await darkScreenshot("03-generating");
    state = "succeeded";
    await waitStatus("success");
    await page.getByRole("button", { name: "播放 镜头 01 · 雨夜街道", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll("video")].some(video => video.readyState >= 2));
    await page.evaluate(() => document.querySelector("video")?.pause());
    await darkScreenshot("04-recovered");
    const current = await snapshot();
    assert.equal(current.nodes.length, 1);
    assert.equal(current.nodes[0].id, "original-node");
    assert.deepEqual(current.nodes[0].position, { x: 0, y: 0 });
    assert.equal(current.applies, 1); assert.equal(retries, 0); assert.equal(creates, 0);
});

test("dark canvas allows an explicit same-node retry only after a confirmed unsent failure", { timeout: 120_000 }, async () => {
    state = "failed";
    await open("dark");
    await page.getByRole("button", { name: "查询并恢复" }).click();
    await page.getByRole("button", { name: "重新生成", exact: true }).waitFor();
    await darkScreenshot("05-confirmed-failure");
    assert.equal(retries, 0);
    await page.getByRole("button", { name: "重新生成", exact: true }).focus();
    await page.keyboard.press("Enter");
    await waitStatus("loading");
    await darkScreenshot("06-retrying");
    state = "succeeded";
    await waitStatus("success");
    assert.equal(retries, 1); assert.equal(creates, 0);
    assert.equal((await snapshot()).nodes[0].id, "original-node");
});

test("dark canvas query and result-application failures keep their respective recovery actions", { timeout: 120_000 }, async () => {
    state = "query-error";
    await open("dark");
    await page.getByRole("button", { name: "查询并恢复" }).click();
    await page.evaluate(async () => { await (window as any).__recoveryPending; });
    await waitStatus("error");
    await darkScreenshot("07-query-failed");
    assert.equal(await page.getByRole("button", { name: "查询并恢复" }).isVisible(), true);
    assert.equal((await snapshot()).nodes[0].metadata.taskStage, "submission_unknown");
    state = "succeeded";
    await page.evaluate(() => (window as any).__recovery.setApplyFails(true));
    await page.getByRole("button", { name: "查询并恢复" }).click();
    await page.getByRole("button", { name: "继续取回", exact: true }).waitFor();
    await darkScreenshot("08-apply-failed");
    await page.evaluate(() => (window as any).__recovery.setApplyFails(false));
    await page.getByRole("button", { name: "继续取回", exact: true }).click();
    await waitStatus("success");
    assert.equal(retries, 0); assert.equal(creates, 0);
});
