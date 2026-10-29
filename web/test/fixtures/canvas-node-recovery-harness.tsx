import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CanvasNode } from "../../src/components/canvas/canvas-node";
import { getAntThemeConfig } from "../../src/lib/app-theme";
import { generationTaskMetadata } from "../../src/lib/canvas/canvas-project-generation";
import { setActiveUserScope } from "../../src/lib/user-scope";
import { useCanvasResourceHandoff } from "../../src/pages/canvas/use-canvas-resource-handoff";
import { retryStoredCanvasVideo } from "../../src/services/canvas-video-retry";
import type { GenerationTask } from "../../src/services/api/task-center";
import { useThemeStore } from "../../src/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "../../src/types/canvas";
import "antd/dist/reset.css";
import "../../src/styles/globals.css";

const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.style.colorScheme = theme;
document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';
useThemeStore.getState().setTheme(theme);
setActiveUserScope("recovery-browser-owner");
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const noop = () => {};

const original = (): CanvasNodeData => ({
    id: "original-node", type: CanvasNodeType.Video, title: "镜头 01 · 雨夜街道", position: { x: 0, y: 0 }, width: 840, height: 472,
    metadata: { taskId: "original-task", taskType: "canvas_video", taskStatus: "failed", status: "error", taskStage: "submission_unknown", generationSubmissionState: "unknown", generationErrorCode: "submission_uncertain", prompt: "雨夜街道，保持角色与镜头连续性" },
});

function Harness() {
    const [nodes, setNodes] = useState([original()]);
    const nodesRef = useRef(nodes);
    nodesRef.current = nodes;
    const [canvasId, setCanvasId] = useState("original-canvas");
    const [details, setDetails] = useState(false);
    const [applies, setApplies] = useState(0);
    const [mediaActive, setMediaActive] = useState(false);
    const [applyFails, setApplyFails] = useState(false);
    const [scopeVersion, setScopeVersion] = useState(0);
    const controllerRef = useRef<AbortController | undefined>(undefined);
    const applyGenerationTaskResult = async (nodeId: string, task: GenerationTask, owns?: () => boolean) => {
        if (owns && !owns()) return;
        if (applyFails) throw Object.assign(new Error("生成结果已保留，画布回写失败，请继续取回"), { code: "result_apply_failed" });
        setApplies(value => value + 1);
        setNodes(current => current.map(node => node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...generationTaskMetadata(task), status: "success", content: "/mock-result.mp4", errorDetails: undefined, generationErrorCode: undefined, hasAudio: false } } : node));
    };
    const { reloadCanvasNodeResource } = useCanvasResourceHandoff({
        projectId: canvasId, linkedProjectId: "", projectLoaded: false, assets: [], assetsHydrated: false, nodesRef,
        searchParams: new URLSearchParams(), setSearchParams: noop, setNodes, getCanvasCenter: () => ({ x: 0, y: 0 }), createHandoffNodes: async () => [],
        applyGenerationTaskResult,
        startGenerationRequest: (_target, _origin, _running, controller = new AbortController()) => { controllerRef.current?.abort(); controllerRef.current = controller; return controller; },
        finishGenerationRequest: (_target, controller) => { if (controllerRef.current === controller) controllerRef.current = undefined; },
    });
    const recover = (node: CanvasNodeData) => {
        const pending = reloadCanvasNodeResource(node);
        (window as any).__recoveryPending = pending;
        return pending;
    };
    useEffect(() => () => controllerRef.current?.abort(), [canvasId]);
    useEffect(() => {
        (window as any).__recovery = {
            snapshot: () => ({ nodes: nodesRef.current, applies, canvasId, scopeVersion }),
            setApplyFails,
            switchCanvas: () => setCanvasId("other-canvas"),
            switchAccount: () => { setActiveUserScope("other-recovery-owner"); setScopeVersion(value => value + 1); },
            replaceTask: () => setNodes(current => current.map(node => ({ ...node, metadata: { ...node.metadata, taskId: "replacement-task", status: "idle" } }))),
            removeNode: () => setNodes([]),
            cancelObservation: () => controllerRef.current?.abort(),
            recoverTwice: () => { const node = nodesRef.current[0]; (window as any).__recoveryPending = Promise.allSettled([reloadCanvasNodeResource(node), reloadCanvasNodeResource(node)]); },
        };
    }, [applies, canvasId, scopeVersion, reloadCanvasNodeResource]);
    const retry = async (node: CanvasNodeData) => {
        const controller = new AbortController();
        controllerRef.current = controller;
        try {
            const task = await retryStoredCanvasVideo(node.metadata!.taskId!, controller.signal, update => setNodes(current => current.map(item => item.id === node.id ? { ...item, metadata: { ...item.metadata, ...generationTaskMetadata(update), status: "loading", generationErrorCode: undefined } } : item)));
            await applyGenerationTaskResult(node.id, task, () => !controller.signal.aborted);
        } catch (error) { console.error(error); }
    };
    return <div data-testid="harness" data-theme={theme}>
        <header style={{ padding: "28px 40px", borderBottom: "1px solid var(--border)", background: "var(--background)" }}>
            <div style={{ fontSize: 22, fontWeight: 650 }}>视频任务 · 原节点恢复验收</div>
            <p style={{ marginTop: 8, color: "var(--muted-foreground)" }}>真实画布节点与恢复逻辑 · 模拟 API · 不调用付费模型</p>
        </header>
        <main data-testid="canvas" style={{ position: "relative", height: 650, overflow: "hidden", background: theme === "dark" ? "#191919" : "#f0f0f0", backgroundImage: `radial-gradient(${theme === "dark" ? "#353535" : "#d2d2d2"} 1px, transparent 1px)`, backgroundSize: "20px 20px" }}>
            <div style={{ position: "absolute", left: "50%", top: 90, width: 840, height: 472, transform: "translateX(-50%)", ["--canvas-live-scale" as string]: 1, ["--canvas-live-inverse-scale" as string]: 1 }}>
                {nodes.map(node => <CanvasNode key={node.id} data={node} scale={1} isSelected={false} mediaActive={mediaActive} onMediaPlayRequest={() => setMediaActive(true)} isRelated={false} isFocusRelated={false} isConnectionTarget={false} showImageInfo={false}
                    onMouseDown={noop} onHoverStart={noop} onHoverEnd={noop} onConnectStart={noop} onResize={noop} onContentChange={noop} onContextMenu={noop}
                    onReloadResource={node => void recover(node)} onRetry={node => void retry(node)} onOpenTaskDetails={() => setDetails(true)} />)}
            </div>
        </main>
        <footer style={{ padding: "16px 40px", color: "var(--muted-foreground)", fontSize: 13 }}>画布节点保留原 ID 和位置。成功画面使用仓库演示视频，仅验证恢复与播放展示。</footer>
        {details ? <aside role="dialog" aria-label="原任务详情" style={{ position: "fixed", right: 0, top: 0, bottom: 0, width: 340, padding: 24, background: "var(--background)", boxShadow: "0 0 30px #0003" }}><h2>原任务详情</h2><p>任务：original-task</p><p>上游提交状态以服务端回执为准</p><button onClick={() => setDetails(false)}>关闭</button></aside> : null}
    </div>;
}

createRoot(document.getElementById("root")!).render(<ConfigProvider theme={getAntThemeConfig(theme === "dark")}><App><QueryClientProvider client={client}><Harness /></QueryClientProvider></App></ConfigProvider>);
