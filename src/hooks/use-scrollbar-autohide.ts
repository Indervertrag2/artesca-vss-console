"use client";

import { useEffect, type RefObject } from "react";

/** Attribute that globals.css keys the visible scrollbar on. */
export const SCROLLBAR_VISIBLE_ATTR = "data-scrollbar-visible";

/** Content strip next to the scrollbar that already counts as "over it", so the
 *  bar shows while the pointer approaches. Some browsers dispatch no pointer
 *  events over the scrollbar itself, so without it the bar might never show. */
const APPROACH_PX = 8;
/** Smallest hover zone, for overlay scrollbars that take no layout width. */
const MIN_ZONE_PX = 12;
/** A measured scrollbar wider than this is a layout reading, not a scrollbar
 *  (an element with no client width yet, a borderless frame); treat it as 0. */
const MAX_SCROLLBAR_PX = 40;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Is (x, y) on, or right next to, the vertical scrollbar at the box's right edge? */
export function isOverVerticalScrollbar(x: number, y: number, box: Box, scrollbarWidth: number): boolean {
  const zone = Math.max(scrollbarWidth + APPROACH_PX, MIN_ZONE_PX);
  return x >= box.right - zone && x <= box.right && y >= box.top && y <= box.bottom;
}

/**
 * Shows a scrollbar only while the pointer is over it or its thumb is being
 * dragged. `target` is a scroll container, or "page" for the document's own
 * scrollbar. Hidden is the CSS default (globals.css), so a reload never flashes
 * a scrollbar before this runs.
 */
export function useScrollbarAutohide(target: RefObject<HTMLElement | null> | "page"): void {
  useEffect(() => {
    const page = target === "page";
    const el = page ? document.documentElement : target.current;
    if (!el) return;

    let shown = false;
    let dragging = false;
    const show = (on: boolean) => {
      if (on === shown) return;
      shown = on;
      if (on) el.setAttribute(SCROLLBAR_VISIBLE_ATTR, "");
      else el.removeAttribute(SCROLLBAR_VISIBLE_ATTR);
    };
    const over = (e: PointerEvent) => {
      const box = page ? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight } : el.getBoundingClientRect();
      const measured = page ? window.innerWidth - el.clientWidth : el.offsetWidth - el.clientWidth;
      const width = measured > 0 && measured <= MAX_SCROLLBAR_PX ? measured : 0;
      return isOverVerticalScrollbar(e.clientX, e.clientY, box, width);
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch" || dragging) return;
      show(over(e));
    };
    const onDown = (e: PointerEvent) => {
      if (shown && over(e)) dragging = true;
    };
    const onUp = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      show(over(e));
    };
    const onLeave = () => {
      if (!dragging) show(false);
    };
    // Leaving the window: pointerout with no element on the other side.
    const onOut = (e: PointerEvent) => {
      if (!e.relatedTarget) onLeave();
    };

    const moveTarget: HTMLElement | Window = page ? window : el;
    moveTarget.addEventListener("pointermove", onMove as EventListener);
    moveTarget.addEventListener("pointerdown", onDown as EventListener);
    window.addEventListener("pointerup", onUp);
    if (page) window.addEventListener("pointerout", onOut);
    else el.addEventListener("pointerleave", onLeave);

    return () => {
      moveTarget.removeEventListener("pointermove", onMove as EventListener);
      moveTarget.removeEventListener("pointerdown", onDown as EventListener);
      window.removeEventListener("pointerup", onUp);
      if (page) window.removeEventListener("pointerout", onOut);
      else el.removeEventListener("pointerleave", onLeave);
      el.removeAttribute(SCROLLBAR_VISIBLE_ATTR);
    };
  }, [target]);
}
