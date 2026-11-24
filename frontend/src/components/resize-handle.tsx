import { cn } from "@/lib/utils"

/**
 * A thin bar between two panels. Drag it to resize (the parent applies the change), double-click to reset,
 * or focus it and use the arrow keys. axis "x" sits between columns, "y" between rows.
 * During a drag the whole window follows the pointer, so fast moves are never lost, and text is not selected.
 */
export function ResizeHandle({ axis, onDrag, onEnd, onReset, label }: {
  axis: "x" | "y"; onDrag: (delta: number) => void; onEnd?: () => void; onReset?: () => void; label: string
}) {
  const start = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    let last = axis === "x" ? e.clientX : e.clientY
    const move = (ev: PointerEvent) => {
      const pos = axis === "x" ? ev.clientX : ev.clientY
      if (pos !== last) { onDrag(pos - last); last = pos }
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
      Object.assign(document.body.style, { cursor: "", userSelect: "" })
      onEnd?.()
    }
    Object.assign(document.body.style, { cursor: axis === "x" ? "col-resize" : "row-resize", userSelect: "none" })
    window.getSelection()?.removeAllRanges()
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
  }
  return (
    <div role="separator" aria-orientation={axis === "x" ? "vertical" : "horizontal"} aria-label={label} title={`${label}: drag to resize, double-click to reset`}
      tabIndex={0} onPointerDown={start} onDoubleClick={onReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 50 : 15
        const d = { ArrowLeft: -step, ArrowUp: -step, ArrowRight: step, ArrowDown: step }[e.key]
        if (d && (axis === "x") === (e.key === "ArrowLeft" || e.key === "ArrowRight")) { e.preventDefault(); onDrag(d); onEnd?.() }
      }}
      className={cn("group relative z-[5] shrink-0 touch-none bg-neutral-200 outline-none transition-colors hover:bg-neutral-400 focus-visible:bg-neutral-500 active:bg-neutral-600",
        axis === "x" ? "w-[5px] cursor-col-resize" : "h-[5px] cursor-row-resize")}>
      <span className={cn("absolute rounded-full bg-neutral-400 group-hover:bg-white", axis === "x" ? "left-1/2 top-1/2 h-8 w-[3px] -translate-x-1/2 -translate-y-1/2" : "left-1/2 top-1/2 h-[3px] w-8 -translate-x-1/2 -translate-y-1/2")} />
    </div>
  )
}
