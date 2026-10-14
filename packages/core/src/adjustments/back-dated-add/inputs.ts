/**
 * Input schemas of the Owner's back-dated new connection (T-045a). Field problems come back as
 * VALIDATION with `details.fields[{ path, code }]` (T-025), with the same paths as
 * `connections.add` (`vcNumber`, `planId`, `rentalPaise`, `startDate`) plus `reason`.
 */
import { z } from "zod";
import { AddConnectionInput, businessDateField, rentalPaiseField } from "../../connections/inputs";
import { reasonField } from "../inputs";

/**
 * `connections.add`'s input plus the Owner's reason, which is stored on every adjustment the add
 * makes (PLAN §8.3 "explicit adjustment with a reason").
 */
export const BackDatedAddConnectionInput = z.intersection(
  AddConnectionInput,
  z.object({ reason: reasonField() }),
);
export type BackDatedAddConnectionCommand = z.output<typeof BackDatedAddConnectionInput>;

const id = () => z.uuid().transform((value) => value.toLowerCase());

/**
 * What the money effect of a new connection depends on: the customer, the rent (a plan or an own
 * amount) and the start day. The VC number is not needed (its problems come with the save).
 */
export const PreviewAddConnectionInput = z
  .object({
    customerId: id(),
    planId: id().nullish(),
    rentalPaise: rentalPaiseField().nullish(),
    startDate: businessDateField(),
  })
  .superRefine((value, ctx) => {
    const hasPlan = value.planId !== undefined && value.planId !== null;
    const hasAmount = value.rentalPaise !== undefined && value.rentalPaise !== null;
    if (hasPlan === hasAmount) {
      ctx.addIssue({ code: "custom", path: ["planId"], message: "plan_or_amount" });
    }
  });
export type PreviewAddConnectionCommand = z.output<typeof PreviewAddConnectionInput>;
