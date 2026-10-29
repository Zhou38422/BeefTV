import { expect, test } from "bun:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasNodeContent } from "../src/components/canvas/canvas-node-content";
import { canvasThemes } from "../src/lib/canvas-theme";
import { canvasGenerationTaskNodes } from "../src/pages/canvas/canvas-generation-failure";
import { isNodeRegenerateBlocked } from "../src/lib/task-outcome";
import type { GenerationTask } from "../src/services/api/task-center";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const node: CanvasNodeData = {
    id: "original-node", type: CanvasNodeType.Video, title: "视频", position: { x: 10, y: 20 }, width: 700, height: 400,
    metadata: { status: "error", taskId: "original-task", taskStage: "submission_unknown", generationErrorCode: "submission_uncertain", generationSubmissionState: "unknown" },
};

function render(value: CanvasNodeData, recovery = true) {
    return renderToStaticMarkup(<CanvasNodeContent
        node={value} theme={canvasThemes.dark} isEditingContent={false} textareaRef={createRef<HTMLTextAreaElement>()}
        isBatchRoot={false} batchCount={0} batchExpanded={false} batchOpening={false} batchRecovering={false}
        onContentChange={() => {}} onStopEditing={() => {}} mentionReferences={[]}
        onRetry={() => {}} onCancelTask={() => {}} onOpenTaskDetails={() => {}} onReloadResource={recovery ? () => {} : undefined}
    />);
}

test("uncertain node offers in-place recovery while keeping paid regeneration blocked", () => {
    const html = render(node);
    expect(html).toContain("查询并恢复");
    expect(html).toContain("查看原任务");
    expect(html).not.toContain(">重新生成<");
    expect(isNodeRegenerateBlocked(node.metadata)).toBe(true);
});

test("confirmed unsent failure unlocks retry on the same node without changing its position", () => {
    const task = { id: "original-task", type: "canvas_video", status: "failed", stage: "任务失败", errorCode: "request_not_sent", error: "请求尚未提交，请重试" } as GenerationTask;
    const updated = canvasGenerationTaskNodes([node], node.id, task);
    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe(node.id);
    expect(updated[0].position).toEqual(node.position);
    expect(isNodeRegenerateBlocked(updated[0].metadata)).toBe(false);
    expect(render(updated[0])).toContain("重新生成");
    expect(render(updated[0])).not.toContain("查询并恢复");
});

test("saved results keep their recovery action and missing task IDs never offer an unusable query", () => {
    expect(render({ ...node, metadata: { ...node.metadata, taskOutcome: { phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" } } })).toContain("继续取回");
    expect(render({ ...node, metadata: { ...node.metadata, taskId: undefined } })).not.toContain("查询并恢复");
    expect(render(node, false)).not.toContain("查询并恢复");
});

test("query progress is distinct from generation and cannot cancel the original task", () => {
    const html = render({ ...node, metadata: { ...node.metadata, status: "loading", taskStatus: "running", taskStage: "正在查询原任务", taskProgress: 42 } });
    expect(html).toContain("正在查询原任务");
    expect(html).not.toContain("取消生成任务");
    expect(html).not.toContain("42%");
});
