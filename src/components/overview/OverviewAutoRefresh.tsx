"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Client island: re-renders the server page every 5 s via router.refresh().
 * The server render collects the snapshot itself; polling /api/status/overview
 * first would collect it twice per refresh. Skipped while the tab is hidden.
 */
export function OverviewAutoRefresh() {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, 5_000);
    return () => clearInterval(id);
  }, [router]);

  return null; // renders nothing — side-effect only
}
