import { expect, mock, test } from "bun:test";
import { recoverCanvasGenerationTask } from "../src/services/canvas-generation-recovery";
import type { GenerationTask } from "../src/services/api/task-center";
import { getActiveUserScope, setActiveUserScope } from "../src/lib/user-scope";
import { UserScopeAbandonedError } from "../src/lib/user-scope-guard";

const uncertain = { id: "original", type: "canvas_video", status: "failed", stage: "submission_unknown", errorCode: "submission_uncertain", providerRequestId: "upstream-original" } as GenerationTask;

test("uncertain video queries its existing upstream task and returns the original task's result", async () => {
    const completed = { ...uncertain, status: "succeeded" as const, stage: "completed", errorCode: undefined };
    const recoverTask = mock(async () => completed);
    const controller = new AbortController();
    const result = await recoverCanvasGenerationTask(uncertain.id, controller.signal, {
        queryGenerationTask: async () => uncertain,
        recoverTask,
    });
    expect(result).toBe(completed);
    expect(recoverTask.mock.calls[0]?.[0]).toBe(uncertain.id);
    expect(recoverTask.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
    expect(recoverTask.mock.calls[0]?.[1]).toHaveProperty("expectedScope");
});

test("confirmed outcomes and active tasks only refresh local state", async () => {
    for (const task of [
        { ...uncertain, status: "running" as const, stage: "generating" },
        { ...uncertain, status: "succeeded" as const, stage: "completed" },
        { ...uncertain, outcome: { phase: "failed", regenerate: "allowed", reason: "not_charged" } as const },
    ]) {
        const recoverTask = mock(async () => task);
        expect(await recoverCanvasGenerationTask(task.id, new AbortController().signal, {
            queryGenerationTask: async () => task, recoverTask,
        })).toBe(task);
        expect(recoverTask).not.toHaveBeenCalled();
    }
});

test("retrievable outcomes delegate recovery without guessing from stale status or missing upstream IDs", async () => {
    for (const task of [
        { ...uncertain, providerRequestId: undefined },
        { ...uncertain, status: "succeeded" as const, stage: "completed" },
    ]) {
        const recoverTask = mock(async () => task);
        const result = await recoverCanvasGenerationTask(task.id, new AbortController().signal, {
            queryGenerationTask: async () => ({ ...task, outcome: { phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" } }), recoverTask,
        });
        expect(result).toBe(task);
        expect(recoverTask).toHaveBeenCalledTimes(1);
    }
});

test("pending upstream result remains uncertain and never becomes a new submission", async () => {
    const result = await recoverCanvasGenerationTask(uncertain.id, new AbortController().signal, {
        queryGenerationTask: async () => uncertain,
        recoverTask: async () => uncertain,
    });
    expect(result.stage).toBe("submission_unknown");
    expect(result.id).toBe(uncertain.id);
});

test("cancellation after the initial query prevents upstream recovery", async () => {
    const controller = new AbortController();
    const recoverTask = mock(async () => uncertain);
    await expect(recoverCanvasGenerationTask(uncertain.id, controller.signal, {
        queryGenerationTask: async () => { controller.abort(); return uncertain; }, recoverTask,
    })).rejects.toThrow();
    expect(recoverTask).not.toHaveBeenCalled();
});

test("mismatched task receipts cannot replace the original node's task", async () => {
    for (const mismatchAt of ["query", "recovery"]) {
        await expect(recoverCanvasGenerationTask(uncertain.id, new AbortController().signal, {
            queryGenerationTask: async () => mismatchAt === "query" ? { ...uncertain, id: "other" } : uncertain,
            recoverTask: async () => ({ ...uncertain, id: "other" }),
        })).rejects.toThrow("回执不匹配");
    }
});

test("account changes discard recovery replies", async () => {
    const scope = getActiveUserScope();
    try {
        await expect(recoverCanvasGenerationTask(uncertain.id, new AbortController().signal, {
            queryGenerationTask: async () => uncertain,
            recoverTask: async () => {
                setActiveUserScope("other-recovery-owner");
                return { ...uncertain, status: "succeeded" as const };
            },
        })).rejects.toBeInstanceOf(UserScopeAbandonedError);
    } finally {
        setActiveUserScope(scope);
    }
});
