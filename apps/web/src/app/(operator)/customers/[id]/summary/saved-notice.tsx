"use client";

/**
 * After "Add customer" or "Change details" the profile opens with `?saved=new|changes`: show the
 * toast once and drop the parameter from the URL (so a reload doesn't repeat it).
 */
import { useToast } from "@cb/ui";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

export function SavedNotice({ message }: { message: string }) {
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const shown = useRef(false);
  useEffect(() => {
    if (shown.current) return;
    shown.current = true;
    toast({ variant: "success", title: message });
    router.replace(pathname, { scroll: false });
  }, [message, pathname, router, toast]);
  return null;
}
