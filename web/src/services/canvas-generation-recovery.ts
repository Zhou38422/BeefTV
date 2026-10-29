import { readTaskOutcome } from "@/lib/task-outcome";
import { assertUserScope, captureUserScope } from "@/lib/user-scope-guard";
import { recoverTask, queryGenerationTask, type GenerationTask } from "@/services/api/task-center";

/** 查询原任务及其已有上游结果；此入口不得创建或重试付费生成。 */
export async function recoverCanvasGenerationTask(taskId: string, signal: AbortSignal,
    dependencies = { queryGenerationTask, recoverTask }): Promise<GenerationTask> {
    const expectedScope = captureUserScope();
    const check = (task?: GenerationTask) => {
        signal.throwIfAborted();
        assertUserScope(expectedScope);
        if (task && task.id !== taskId) throw new Error("原任务回执不匹配，未更新画布");
    };
    check();
    let task = await dependencies.queryGenerationTask(taskId, { signal, expectedScope });
    check(task);
    if (readTaskOutcome(task)?.phase === "retrievable") {
        const recovered = await dependencies.recoverTask(task.id, { signal, expectedScope });
        check(recovered);
        task = recovered;
    }
    return task;
}
