"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/cameras", label: "Cameras" },
  { href: "/cameras/sources", label: "External Sources" },
];

/** Tabs between the camera list and the sources that are not cameras. */
export function CamerasSubnav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-5 border-b border-border text-sm">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={cn(
            "-mb-px border-b-2 px-0.5 pb-2",
            pathname === t.href
              ? "border-primary font-medium text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
