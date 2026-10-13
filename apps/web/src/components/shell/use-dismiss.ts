"use client";

import { usePathname } from "next/navigation";
import { type RefObject, useEffect } from "react";

/**
 * Closes a small pop-up menu (account menu, the phone "More" list) the expected ways: Escape
 * (focus goes back to its button), a tap or click outside `container`, and moving to another page.
 */
export function useDismiss(
  open: boolean,
  close: () => void,
  container: RefObject<HTMLElement | null>,
  trigger: RefObject<HTMLElement | null>,
): void {
  const pathname = usePathname();

  // A link inside the menu was followed: the layout stays mounted, so close it here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on every page change on purpose.
  useEffect(() => {
    close();
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      trigger.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (container.current && !container.current.contains(event.target as Node)) close();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, close, container, trigger]);
}
