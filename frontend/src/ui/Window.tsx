import { Show, createSignal, type JSX } from "solid-js";
import { Portal } from "solid-js/web";

export interface WindowProps {
    id: string;
    title: string | JSX.Element;
    isOpen: boolean;
    onClose: () => void;
    isPinned?: boolean;
    onTogglePin?: () => void;
    initialPos?: { x: number; y: number };
    initialSize?: { width: number; height: number };
    minWidth?: number;
    minHeight?: number;
    zIndex?: number;
    onFocus?: () => void;
    actions?: JSX.Element;
    children: JSX.Element;
}

export function Window(props: WindowProps) {
    const minW = () => props.minWidth ?? 340;
    const minH = () => props.minHeight ?? 220;

    const [pos, setPos] = createSignal(props.initialPos ?? { x: 80, y: 70 });
    const [size, setSize] = createSignal(props.initialSize ?? { width: 480, height: 500 });
    const [isMinimized, setIsMinimized] = createSignal(false);
    const [isDragging, setIsDragging] = createSignal(false);
    const [isResizing, setIsResizing] = createSignal(false);

    // Mouse drag logic for header
    let dragStartMouse = { x: 0, y: 0 };
    let dragStartPos = { x: 0, y: 0 };

    const handleHeaderMouseDown = (e: MouseEvent) => {
        // Ignore clicks on header buttons/inputs
        if ((e.target as HTMLElement).closest("button, input, select, a")) return;

        props.onFocus?.();
        setIsDragging(true);
        dragStartMouse = { x: e.clientX, y: e.clientY };
        dragStartPos = { ...pos() };

        const handleMouseMove = (ev: MouseEvent) => {
            const dx = ev.clientX - dragStartMouse.x;
            const dy = ev.clientY - dragStartMouse.y;
            const maxX = Math.max(10, window.innerWidth - 120);
            const maxY = Math.max(10, window.innerHeight - 40);

            const nextX = Math.min(maxX, Math.max(0, dragStartPos.x + dx));
            const nextY = Math.min(maxY, Math.max(0, dragStartPos.y + dy));

            setPos({ x: nextX, y: nextY });
        };

        const handleMouseUp = () => {
            setIsDragging(false);
            window.removeEventListener("mousemove", handleMouseMove);
            window.removeEventListener("mouseup", handleMouseUp);
        };

        window.addEventListener("mousemove", handleMouseMove);
        window.addEventListener("mouseup", handleMouseUp);
    };

    // Mouse resize logic for bottom-right corner handle
    let resizeStartMouse = { x: 0, y: 0 };
    let resizeStartSize = { width: 0, height: 0 };

    const handleResizeMouseDown = (e: MouseEvent) => {
        e.stopPropagation();
        props.onFocus?.();
        setIsResizing(true);
        resizeStartMouse = { x: e.clientX, y: e.clientY };
        resizeStartSize = { ...size() };

        const handleMouseMove = (ev: MouseEvent) => {
            const dw = ev.clientX - resizeStartMouse.x;
            const dh = ev.clientY - resizeStartMouse.y;

            const nextW = Math.max(minW(), resizeStartSize.width + dw);
            const nextH = Math.max(minH(), resizeStartSize.height + dh);

            setSize({ width: nextW, height: nextH });
        };

        const handleMouseUp = () => {
            setIsResizing(false);
            window.removeEventListener("mousemove", handleMouseMove);
            window.removeEventListener("mouseup", handleMouseUp);
        };

        window.addEventListener("mousemove", handleMouseMove);
        window.addEventListener("mouseup", handleMouseUp);
    };

    return (
        <Portal>
            <div
                class="ui-window-frame"
                classList={{
                    active: props.isOpen,
                    pinned: props.isPinned,
                    minimized: isMinimized(),
                    dragging: isDragging(),
                    resizing: isResizing(),
                }}
                style={{
                    display: props.isOpen ? "flex" : "none",
                    position: "fixed",
                    left: `${pos().x}px`,
                    top: `${pos().y}px`,
                    width: `${size().width}px`,
                    height: isMinimized() ? "auto" : `${size().height}px`,
                    "z-index": props.zIndex ?? 100,
                }}
                onMouseDown={() => props.onFocus?.()}
            >
                <header class="ui-window-header" onMouseDown={handleHeaderMouseDown}>
                    <div class="ui-window-title">
                        <Show when={props.isPinned}>
                            <span class="ui-window-pin-badge" title="Window is pinned on top">📌</span>
                        </Show>
                        <span class="title-text">{props.title}</span>
                    </div>

                    <div class="ui-window-controls" onMouseDown={(e) => e.stopPropagation()}>
                        {props.actions}

                        <Show when={props.onTogglePin}>
                            <button
                                type="button"
                                class="win-btn pin-btn"
                                classList={{ active: props.isPinned }}
                                title={props.isPinned ? "Unpin window" : "Pin window on top"}
                                onClick={props.onTogglePin}
                            >
                                📌
                            </button>
                        </Show>

                        <button
                            type="button"
                            class="win-btn min-btn"
                            title={isMinimized() ? "Expand window" : "Minimize window"}
                            onClick={() => setIsMinimized((m) => !m)}
                        >
                            {isMinimized() ? "🗖" : "—"}
                        </button>

                        <button
                            type="button"
                            class="win-btn close-btn"
                            title="Close window (preserves data)"
                            onClick={props.onClose}
                        >
                            ✕
                        </button>
                    </div>
                </header>

                <Show when={!isMinimized()}>
                    <div class="ui-window-body">{props.children}</div>
                    <div
                        class="ui-window-resize-handle"
                        title="Drag to resize"
                        onMouseDown={handleResizeMouseDown}
                    />
                </Show>
            </div>
        </Portal>
    );
}
