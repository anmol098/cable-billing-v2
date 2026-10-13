/**
 * "Add customer" with a connection (T-034): the form state is T-033's customer state plus the
 * connection part of step 2. Client-safe.
 */

import type { CustomerFormState } from "../../../_components/form-state";
import type { ConnectionFormState } from "../../../[id]/connections/_parts/form-state";

export interface AddCustomerState extends CustomerFormState {
  /** Step 2's problems and what was typed there. */
  readonly connection?: ConnectionFormState;
}

/** The Stepper index of "Connections (VC)". */
export const CONNECTIONS_STEP = 1;
