// @vitest-environment jsdom
/**
 * The page's and the sidebar's scrollbars show only while the pointer is over
 * them (or a thumb is dragged), and the sidebar keeps its scroll offset across
 * the remount every navigation and reload causes. Verifies:
 *   1. isOverVerticalScrollbar: the zone covers the scrollbar plus a short
 *      approach strip, with a floor for zero-width overlay scrollbars.
 *   2. useScrollbarAutohide("page") toggles data-scrollbar-visible on <html>
 *      from window pointer moves, and clears it when the pointer leaves.
 *   3. On an element: hover shows, pointerleave hides, a drag that started on
 *      the bar keeps it shown until pointerup.
 *   4. Shell restores the sidebar's scrollTop from sessionStorage on mount and
 *      saves it while the sidebar scrolls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import React, { act, useRef } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/components/BoxModeProvider", () => ({
  useBoxMode: () => null,
  useAiFactoryUrl: () => null,
}));
vi.mock("@/components/BoxModeBanner", () => ({ BoxModeBanner: () => null }));
vi.mock("@/components/Nav", () => ({ Nav: () => <nav data-testid="nav" /> }));
vi.mock("@/components/brand/PortalHeader", () => ({ PortalHeader: () => <header /> }));

import {
  SCROLLBAR_VISIBLE_ATTR,
  isOverVerticalScrollbar,
  useScrollbarAutohide,
} from "@/hooks/use-scrollbar-autohide";
import { Shell } from "@/components/Shell";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function mount(node: React.ReactNode) {
  act(() => {
    root.render(node);
  });
}

function pointer(target: EventTarget, type: string, clientX: number, clientY = 10) {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { clientX, clientY, bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  if (!("ResizeObserver" in globalThis)) {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  }
  sessionStorage.clear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("isOverVerticalScrollbar", () => {
  const box = { left: 0, top: 0, right: 1000, bottom: 800 };

  it("covers a classic scrollbar plus the approach strip", () => {
    expect(isOverVerticalScrollbar(995, 100, box, 17)).toBe(true);
    expect(isOverVerticalScrollbar(1000 - 17 - 8, 100, box, 17)).toBe(true);
    expect(isOverVerticalScrollbar(1000 - 17 - 9, 100, box, 17)).toBe(false);
  });

  it("keeps a minimum zone for overlay scrollbars that take no width", () => {
    expect(isOverVerticalScrollbar(1000 - 12, 100, box, 0)).toBe(true);
    expect(isOverVerticalScrollbar(1000 - 13, 100, box, 0)).toBe(false);
  });

  it("ignores points outside the box vertically", () => {
    expect(isOverVerticalScrollbar(995, 900, box, 17)).toBe(false);
  });
});

describe("useScrollbarAutohide", () => {
  function PageProbe() {
    useScrollbarAutohide("page");
    return null;
  }

  it("shows the page scrollbar only near the right edge and hides it on leaving the window", () => {
    const html = document.documentElement;
    mount(<PageProbe />);
    expect(html.hasAttribute(SCROLLBAR_VISIBLE_ATTR)).toBe(false);

    pointer(window, "pointermove", window.innerWidth - 5);
    expect(html.hasAttribute(SCROLLBAR_VISIBLE_ATTR)).toBe(true);

    pointer(window, "pointermove", 100);
    expect(html.hasAttribute(SCROLLBAR_VISIBLE_ATTR)).toBe(false);

    pointer(window, "pointermove", window.innerWidth - 5);
    pointer(window, "pointerout", window.innerWidth - 5);
    expect(html.hasAttribute(SCROLLBAR_VISIBLE_ATTR)).toBe(false);
  });

  it("on an element: hover shows, leave hides, a drag keeps it shown until pointerup", () => {
    let el!: HTMLDivElement;
    function ElementProbe() {
      const ref = useRef<HTMLDivElement>(null);
      useScrollbarAutohide(ref);
      return (
        <div
          ref={(node) => {
            ref.current = node;
            if (node) {
              el = node;
              node.getBoundingClientRect = () => ({ left: 0, top: 0, right: 240, bottom: 600 }) as DOMRect;
            }
          }}
        />
      );
    }
    mount(<ElementProbe />);

    pointer(el, "pointermove", 235);
    expect(el.hasAttribute(SCROLLBAR_VISIBLE_ATTR)).toBe(true);
    act(() => {
      el.dispatchEvent(new MouseEvent("pointerleave"));
    });
    expect(el.hasAttribute(SCROLLBAR_VISIBLE_ATTR)).toBe(false);

    pointer(el, "pointermove", 235);
    pointer(el, "pointerdown", 235);
    pointer(el, "pointermove", 50);
    expect(el.hasAttribute(SCROLLBAR_VISIBLE_ATTR)).toBe(true);
    pointer(window, "pointerup", 50);
    expect(el.hasAttribute(SCROLLBAR_VISIBLE_ATTR)).toBe(false);
  });
});

describe("Shell sidebar", () => {
  it("restores the sidebar's scroll offset on mount and saves it while scrolling", () => {
    sessionStorage.setItem("console:sidebar:scrollTop", "320");
    mount(
      <Shell>
        <p>page</p>
      </Shell>,
    );
    const scroller = container.querySelector(".scroll-autohide") as HTMLDivElement;
    expect(scroller).not.toBeNull();
    expect(scroller.scrollTop).toBe(320);

    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    act(() => {
      scroller.scrollTop = 75;
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(sessionStorage.getItem("console:sidebar:scrollTop")).toBe("75");
  });

  it("sticks the sidebar under the header with a height that ends at the viewport bottom", () => {
    mount(
      <Shell>
        <p>page</p>
      </Shell>,
    );
    const aside = container.querySelector("aside") as HTMLElement;
    expect(aside.className).toContain("sticky");
    expect(aside.style.top).not.toBe("");
    expect(aside.style.height).toContain("100dvh");
  });
});
