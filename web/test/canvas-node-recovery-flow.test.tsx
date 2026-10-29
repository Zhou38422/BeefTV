import { expect, mock, test } from "bun:test";
import { App } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { useCanvasResourceHandoff } from "../src/pages/canvas/use-canvas-resource-handoff";
import { apiClient } from "../src/services/api/request";
import type { GenerationTask } from "../src/services/api/task-center";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const original = (): CanvasNodeData => ({ id: "node-original", type: CanvasNodeType.Video, title: "视频", position: { x: 10, y: 20 }, width: 700, height: 400, metadata: { taskId: "task-original", status: "error", taskStage: "submission_unknown", generationErrorCode: "submission_uncertain" } });
const task = (status: GenerationTask["status"], stage: string, errorCode?: string): GenerationTask => ({ id: "task-original", type: "canvas_video", status, stage, errorCode, attempts: 1, createdAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:01Z" });

function harness() {
    const nodesRef = { current: [original()] };
    const applyGenerationTaskResult = mock(async (_nodeId: string, _task: GenerationTask, owns?: () => boolean) => { expect(owns?.()).toBe(true); });
    const controller = new AbortController();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let recover!: ReturnType<typeof useCanvasResourceHandoff>["reloadCanvasNodeResource"];
    function Harness() {
        recover = useCanvasResourceHandoff({
            projectId: "canvas-original", linkedProjectId: "", projectLoaded: false, assets: [], assetsHydrated: false,
            nodesRef, searchParams: new URLSearchParams(), setSearchParams: () => {},
            setNodes: (next) => { nodesRef.current = typeof next === "function" ? next(nodesRef.current) : next; },
            getCanvasCenter: () => ({ x: 0, y: 0 }), createHandoffNodes: async () => [],
            applyGenerationTaskResult, startGenerationRequest: () => controller, finishGenerationRequest: () => {},
        }).reloadCanvasNodeResource;
        return null;
    }
    renderToStaticMarkup(<QueryClientProvider client={client}><App><Harness /></App></QueryClientProvider>);
    return { nodesRef, applyGenerationTaskResult, controller, recover, client };
}

test("refreshing a confirmed failure keeps the original node and removes the stale uncertain state", async () => {
    const adapter = apiClient.defaults.adapter;
    const current = harness();
    try {
        apiClient.defaults.adapter = async (config) => {
            expect(config.method).toBe("get");
            return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, data: task("failed", "任务失败", "request_not_sent") } };
        };
        await current.recover(current.nodesRef.current[0]);
        expect(current.nodesRef.current).toHaveLength(1);
        expect(current.nodesRef.current[0].id).toBe("node-original");
        expect(current.nodesRef.current[0].metadata?.generationErrorCode).toBe("request_not_sent");
        expect(current.applyGenerationTaskResult).not.toHaveBeenCalled();
    } finally { apiClient.defaults.adapter = adapter; current.client.clear(); }
});

test("an active original task is observed through completion and applied to the same node", async () => {
    const adapter = apiClient.defaults.adapter;
    const current = harness();
    let reads = 0;
    try {
        apiClient.defaults.adapter = async (config) => {
            expect(config.method).toBe("get");
            return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, data: ++reads === 1 ? task("running", "generating") : task("succeeded", "completed") } };
        };
        await current.recover(current.nodesRef.current[0]);
        expect(current.applyGenerationTaskResult).toHaveBeenCalledTimes(1);
        expect(current.applyGenerationTaskResult.mock.calls[0]?.[0]).toBe("node-original");
        expect(current.applyGenerationTaskResult.mock.calls[0]?.[1].id).toBe("task-original");
    } finally { apiClient.defaults.adapter = adapter; current.client.clear(); }
});

test("a terminal failure received while observing the original task clears the uncertainty", async () => {
    const adapter = apiClient.defaults.adapter;
    const current = harness();
    let reads = 0;
    try {
        apiClient.defaults.adapter = async (config) => ({ config, status: 200, statusText: "OK", headers: {}, data: { code: 0, data: ++reads === 1 ? task("running", "generating") : task("failed", "任务失败", "provider_unavailable") } });
        await current.recover(current.nodesRef.current[0]);
        expect(current.nodesRef.current[0].metadata?.status).toBe("error");
        expect(current.nodesRef.current[0].metadata?.generationErrorCode).toBe("provider_unavailable");
        expect(current.applyGenerationTaskResult).not.toHaveBeenCalled();
    } finally { apiClient.defaults.adapter = adapter; current.client.clear(); }
});

test("a response for a replaced node task is discarded", async () => {
    const adapter = apiClient.defaults.adapter;
    const current = harness();
    try {
        apiClient.defaults.adapter = async (config) => {
            current.nodesRef.current[0].metadata!.taskId = "new-task";
            return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, data: task("succeeded", "completed") } };
        };
        await current.recover(original());
        expect(current.applyGenerationTaskResult).not.toHaveBeenCalled();
        expect(current.nodesRef.current[0].metadata?.taskId).toBe("new-task");
    } finally { apiClient.defaults.adapter = adapter; current.client.clear(); }
});
