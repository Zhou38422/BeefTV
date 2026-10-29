import { explainGenerationError } from "@/lib/generation-error";
import { assertUserScope, captureUserScope } from "@/lib/user-scope-guard";
import { queryFailedVideoProviderTask, queryGenerationTask, type GenerationTask } from "@/services/api/task-center";

/** 查询原任务及其已有上游结果；此入口不得创建或重试付费生成。 */
export async function recoverCanvasGenerationTask(taskId: string, signal: AbortSignal,
    dependencies = { queryGenerationTask, queryFailedVideoProviderTask }): Promise<GenerationTask> {
    const expectedScope = captureUserScope();
    const check = (task?: GenerationTask) => {
        signal.throwIfAborted();
        assertUserScope(expectedScope);
        if (task && task.id !== taskId) throw new Error("原任务回执不匹配，未更新画布");
    };
    check();
    let task = await dependencies.queryGenerationTask(taskId, { signal, expectedScope });
    check(task);
    const uncertain = explainGenerationError({ code: task.errorCode, message: task.error }, { stage: task.stage }).uncertain;
    if (task.status === "failed" && uncertain && task.providerRequestId && (task.type.startsWith("canvas_video") || task.type.startsWith("video_"))) {
        // 上游结果下载可能超过普通 JSON 请求的启动超时；取消仍由节点请求生命周期控制。
        const recovered = await dependencies.queryFailedVideoProviderTask(task.id, { signal, expectedScope, timeout: 0 });
        check(recovered.task);
        task = recovered.task;
    }
    return task;
}
