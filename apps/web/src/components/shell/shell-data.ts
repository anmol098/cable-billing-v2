/**
 * Server only. What the shell shows about the signed-in tenant: business name, the user's name and the
 * subscription state for the banner. One read-only `withTenant` transaction per request (RLS
 * limits every table to the caller's tenant; ids come from the TenantContext, never the client).
 */
import { autopayOf, type TenantContext } from "@cb/core";
import type { SubscriptionStatus } from "@cb/db";
import { cache } from "react";
import { getServerRuntime } from "@/lib/auth/server";

export type ShellData = {
  operatorName: string;
  userName: string;
  subscription: {
    status: SubscriptionStatus | null;
    graceEndsAt: Date | null;
    /** T-085: the trial-ending banner. */
    trialEndsAt: Date | null;
    /** T-085: autopay already set up (no "pay" banner during the trial). */
    autopayOn: boolean;
  };
};

export const loadShellData = cache(async (ctx: TenantContext): Promise<ShellData> => {
  return getServerRuntime().db.withTenant(
    ctx.operatorId,
    async (tx) => {
      const operator = await tx.query.operators.findFirst({
        columns: { name: true },
        where: (operators, { eq }) => eq(operators.id, ctx.operatorId),
      });
      const user = await tx.query.users.findFirst({
        columns: { name: true },
        where: (users, { eq }) => eq(users.id, ctx.userId),
      });
      const subscription = await tx.query.subscriptions.findFirst({
        columns: {
          status: true,
          graceEndsAt: true,
          trialEndsAt: true,
          razorpaySubscriptionId: true,
          razorpayStatus: true,
        },
      });
      return {
        operatorName: operator?.name ?? "",
        userName: user?.name ?? "",
        subscription: {
          status: subscription?.status ?? null,
          graceEndsAt: subscription?.graceEndsAt ?? null,
          trialEndsAt: subscription?.trialEndsAt ?? null,
          autopayOn:
            Boolean(subscription?.razorpaySubscriptionId) &&
            autopayOf(subscription?.razorpayStatus ?? null) === "on",
        },
      };
    },
    { accessMode: "read only" },
  );
});
