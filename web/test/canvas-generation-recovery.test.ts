import { expect, mock, test } from "bun:test";
import { recoverCanvasGenerationTask } from "../src/services/canvas-generation-recovery";
import type { GenerationTask } from "../src/services/api/task-center";
import { getActiveUserScope, setActiveUserScope } from "../src/lib/user-scope";
import { UserScopeAbandonedError } from "../src/lib/user-scope-guard";

const uncertain = { id: "original", type: "canvas_video", status: "failed", stage: "submission_unknown", errorCode: "submission_uncertain", providerRequestId: "upstream-original" } as GenerationTask;

test("uncertain video queries its existing upstream task and returns the original task's result", async () => {
    const completed = { ...uncertain, status: "succeeded" as const, stage: "completed", errorCode: undefined };
    const queryFailedVideoProviderTask = mock(async () => ({ task: completed, providerStatus: "succeeded", recovered: true }));
    const controller = new AbortController();
    const result = await recoverCanvasGenerationTask(uncertain.id, controller.signal, {
        queryGenerationTask: async () => uncertain,
        queryFailedVideoProviderTask,
    });
    expect(result).toBe(completed);
    expect(queryFailedVideoProviderTask.mock.calls[0]?.[0]).toBe(uncertain.id);
    expect(queryFailedVideoProviderTask.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal, timeout: 0 });
    expect(queryFailedVideoProviderTask.mock.calls[0]?.[1]).toHaveProperty("expectedScope");
});

test("confirmed failures, active tasks and missing upstream IDs only refresh local state", async () => {
    for (const task of [
        { ...uncertain, status: "running" as const },
        { ...uncertain, status: "succeeded" as const },
        { ...uncertain, stage: "任务失败", errorCode: "request_not_sent" },
        { ...uncertain, providerRequestId: undefined },
        { ...uncertain, type: "canvas_image" },
    ]) {
        const queryFailedVideoProviderTask = mock(async () => ({ task, providerStatus: "running", recovered: false }));
        expect(await recoverCanvasGenerationTask(task.id, new AbortController().signal, {
            queryGenerationTask: async () => task, queryFailedVideoProviderTask,
        })).toBe(task);
        expect(queryFailedVideoProviderTask).not.toHaveBeenCalled();
    }
});

test("pending upstream result remains uncertain and never becomes a new submission", async () => {
    const result = await recoverCanvasGenerationTask(uncertain.id, new AbortController().signal, {
        queryGenerationTask: async () => uncertain,
        queryFailedVideoProviderTask: async () => ({ task: uncertain, providerStatus: "running", recovered: false }),
    });
    expect(result.stage).toBe("submission_unknown");
    expect(result.id).toBe(uncertain.id);
});

test("cancellation after the initial query prevents upstream recovery", async () => {
    const controller = new AbortController();
    const queryFailedVideoProviderTask = mock(async () => ({ task: uncertain, providerStatus: "running", recovered: false }));
    await expect(recoverCanvasGenerationTask(uncertain.id, controller.signal, {
        queryGenerationTask: async () => { controller.abort(); return uncertain; }, queryFailedVideoProviderTask,
    })).rejects.toThrow();
    expect(queryFailedVideoProviderTask).not.toHaveBeenCalled();
});

test("mismatched task receipts cannot replace the original node's task", async () => {
    for (const mismatchAt of ["query", "recovery"]) {
        await expect(recoverCanvasGenerationTask(uncertain.id, new AbortController().signal, {
            queryGenerationTask: async () => mismatchAt === "query" ? { ...uncertain, id: "other" } : uncertain,
            queryFailedVideoProviderTask: async () => ({ task: { ...uncertain, id: "other" }, providerStatus: "succeeded", recovered: true }),
        })).rejects.toThrow("回执不匹配");
    }
});

test("account changes discard recovery replies", async () => {
    const scope = getActiveUserScope();
    try {
        await expect(recoverCanvasGenerationTask(uncertain.id, new AbortController().signal, {
            queryGenerationTask: async () => uncertain,
            queryFailedVideoProviderTask: async () => {
                setActiveUserScope("other-recovery-owner");
                return { task: { ...uncertain, status: "succeeded" as const }, providerStatus: "succeeded", recovered: true };
            },
        })).rejects.toBeInstanceOf(UserScopeAbandonedError);
    } finally {
        setActiveUserScope(scope);
    }
});
