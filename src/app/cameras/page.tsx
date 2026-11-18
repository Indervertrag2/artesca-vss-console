"use client";

import { redirect } from "next/navigation";
import { useKiosk } from "@/components/KioskProvider";
import { Shell } from "@/components/Shell";
import { CameraTable } from "@/components/cameras/CameraTable";
import { CamerasSubnav } from "@/components/cameras/CamerasSubnav";

export default function CamerasPage() {
  const { kiosk } = useKiosk();
  if (kiosk) redirect("/");

  return (
    <Shell>
      <div className="max-w-6xl mx-auto space-y-4">
        <CamerasSubnav />
        <CameraTable />
      </div>
    </Shell>
  );
}
