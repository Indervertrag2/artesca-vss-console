"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { LogOut } from "lucide-react";
import { useKiosk } from "./KioskProvider";
import { useAiFactoryUrl, useBoxMode } from "./BoxModeProvider";
import { BoxModeBanner } from "./BoxModeBanner";
import { Nav } from "./Nav";
import { PortalHeader } from "./brand/PortalHeader";
import { useScrollbarAutohide } from "@/hooks/use-scrollbar-autohide";
import { cn } from "@/lib/utils";

interface ShellProps {
  children: React.ReactNode;
  className?: string;
}

/** Sidebar scroll offset, kept per tab. Every page renders its own Shell, so
 *  without it the sidebar jumps back to the top on each navigation and reload. */
const SIDEBAR_SCROLL_KEY = "console:sidebar:scrollTop";
/** PortalHeader's height until it is measured: py-3, the h-6 logo, its 1px border. */
const HEADER_HEIGHT_FALLBACK = "calc(3rem + 1px)";

export function Shell({ children, className }: ShellProps) {
  const { kiosk } = useKiosk();
  const pathname = usePathname();
  const boxMode = useBoxMode();
  const aiFactoryUrl = useAiFactoryUrl();
  const rootRef = useRef<HTMLDivElement>(null);
  const navScrollRef = useRef<HTMLDivElement>(null);
  const [headerHeight, setHeaderHeight] = useState(HEADER_HEIGHT_FALLBACK);
  useScrollbarAutohide(navScrollRef);

  // The sidebar sticks right under the sticky header, so it needs its height.
  useLayoutEffect(() => {
    const header = rootRef.current?.querySelector("header");
    if (!header) return;
    const measure = () => setHeaderHeight(`${header.offsetHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, [kiosk]);

  // Restore the sidebar's offset before paint, save it while it scrolls.
  useLayoutEffect(() => {
    const el = navScrollRef.current;
    if (!el) return;
    try {
      el.scrollTop = Number(sessionStorage.getItem(SIDEBAR_SCROLL_KEY)) || 0;
    } catch {
      // storage blocked: start at the top
    }
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        try {
          sessionStorage.setItem(SIDEBAR_SCROLL_KEY, String(el.scrollTop));
        } catch {
          // storage blocked: nothing to keep
        }
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [kiosk]);

  return (
    <div ref={rootRef} className="flex min-h-screen flex-col bg-background">
      {!kiosk && (
        <PortalHeader eyebrow="ARTESCA × Pyramid × NVIDIA VSS" homeHref="/">
          <span
            className="ml-auto shrink-0 rounded bg-brand-indigo/40 px-1.5 py-0.5 text-[10px] font-semibold text-brand-teal-light"
            style={{ fontFamily: "var(--font-display)" }}
          >
            :8800
          </span>
        </PortalHeader>
      )}

      {/* While the AI Factory has the box in another GPU mode: a strip here,
          or a full-screen notice in kiosk mode (Exit kiosk stays above it). */}
      <BoxModeBanner boxMode={boxMode} aiFactoryUrl={aiFactoryUrl} kiosk={kiosk} />

      <div className="flex flex-1">
        {/* Sticky under the header with a scroll area of its own: the page
            scrolls without taking the sidebar along, and the sidebar's end
            does not hand the wheel on to the page (overscroll-contain). */}
        {!kiosk && (
          <aside
            className="sticky flex w-60 shrink-0 flex-col self-start border-r border-border bg-brand-white"
            style={{ top: headerHeight, height: `calc(100dvh - ${headerHeight})` }}
          >
            <div ref={navScrollRef} className="scroll-autohide flex-1 overflow-y-auto overscroll-contain">
              <Nav />
            </div>
          </aside>
        )}

        <main className={cn("flex-1 p-6", className)}>{children}</main>
      </div>

      {/* Kiosk exit — the only visible chrome in kiosk mode. A plain <a> (full
          navigation) so the middleware processes ?mode=normal and clears the
          HttpOnly kiosk cookie server-side. Corner-anchored to stay out of the
          showroom display. */}
      {kiosk && (
        <a
          href={`${pathname}?mode=normal`}
          title="Leave kiosk mode and return to the operator view"
          className="fixed bottom-4 right-4 z-50 inline-flex items-center gap-1.5 rounded-full border border-border bg-card/90 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-card hover:text-foreground"
        >
          <LogOut className="h-3.5 w-3.5" />
          Exit kiosk
        </a>
      )}
    </div>
  );
}
