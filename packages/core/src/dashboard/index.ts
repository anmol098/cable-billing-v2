/**
 * The Home page read (T-083, PLAN §12.1 "Home", §12.3): `homeDashboard` (`dashboard.home`), its
 * view types and the pure subscription/day rules. How the numbers are defined: see `home.ts`.
 */
export { HomeDashboardInput, homeDashboard } from "./home";
export { daysBetween, subscriptionSummary } from "./rules";
export {
  type CollectedMoney,
  type HomeDashboard,
  SETUP_STEP_KEYS,
  type SetupStepKey,
  type SubscriptionSummary,
} from "./types";
