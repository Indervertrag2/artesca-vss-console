"use client";

import { useScrollbarAutohide } from "@/hooks/use-scrollbar-autohide";

/** The document's own scrollbar shows only while the pointer is over it.
 *  Mounted in the root layout so it covers every page, sign-in and kiosk included. */
export function PageScrollbarAutohide() {
  useScrollbarAutohide("page");
  return null;
}
