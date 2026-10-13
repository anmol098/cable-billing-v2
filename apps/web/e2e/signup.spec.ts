/**
 * Self sign-up (T-027) against `next start` and a real, migrated database: sign up → the account
 * can't be used yet → the emailed link (read from the server's test outbox, `EMAIL_OUTBOX_DIR`,
 * which playwright.config.ts sets) → password → home, signed in, with a trialing tenant.
 *
 * Needs `DATABASE_URL` (migrated) and `BETTER_AUTH_SECRET`, like auth.spec.ts. Skipped against a
 * deployed URL (`E2E_BASE_URL`): there is no outbox to read there.
 */
import { randomBytes, randomInt } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createDb } from "@cb/db";
import { expect, type Page, test } from "@playwright/test";

const DATABASE_URL = process.env.DATABASE_URL;
const OUTBOX = process.env.EMAIL_OUTBOX_DIR;
const PASSWORD = "e2e signup 4321";

interface OutboxEmail {
  to: string;
  subject: string;
  text: string;
}

/** The newest email to `to` in the outbox, if any. */
async function lastEmailTo(to: string): Promise<OutboxEmail | undefined> {
  if (!OUTBOX) return undefined;
  let names: string[];
  try {
    names = (await readdir(OUTBOX)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return undefined;
  }
  for (const name of names.reverse()) {
    const email = JSON.parse(await readFile(join(OUTBOX, name), "utf8")) as OutboxEmail;
    if (email.to === to) return email;
  }
  return undefined;
}

/** The form's error box (Next's route announcer also has role="alert"). */
const formAlert = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');

test.describe("self sign-up", () => {
  test.skip(
    !DATABASE_URL || !OUTBOX || Boolean(process.env.E2E_BASE_URL),
    "needs DATABASE_URL (a migrated database), BETTER_AUTH_SECRET and the local server's outbox",
  );

  test("sign up → can't sign in yet → email link → password → home with a 30-day trial", async ({
    page,
  }) => {
    const run = randomBytes(4).toString("hex");
    const mobile = `9${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`;
    const email = `e2e-signup-${run}@cable.test`;

    await page.goto("/signup");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Create your account");
    await page.getByLabel("Business name").fill(`E2E Cable ${run}`);
    await page.getByLabel("Your name").fill("E2E Owner");
    await page.getByLabel("Mobile no.").fill(`+91 ${mobile}`);
    await page.getByLabel("Email").fill(email.toUpperCase());

    // A bad password is caught first, in words, and the typed fields stay.
    await page.getByLabel("Password", { exact: true }).fill("short");
    await page.getByRole("button", { name: "Start 30 days free" }).click();
    await expect(formAlert(page)).toHaveText("Fix the boxes marked in red.");
    await expect(page.getByLabel("Password", { exact: true })).toHaveAccessibleDescription(
      "Use at least 8 letters, numbers or signs.",
    );
    await expect(page.getByLabel("Business name")).toHaveValue(`E2E Cable ${run}`);

    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Start 30 days free" }).click();
    await expect(page.getByText(`We sent a link to ${email}.`)).toBeVisible();

    // Not confirmed yet: there is no account, so signing in fails like any wrong password.
    await page.goto("/login");
    await page.getByLabel("Mobile no., user name or email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(formAlert(page)).toHaveText("Wrong user name or password.");

    // The email (captured by the server's test transport).
    await expect.poll(() => lastEmailTo(email), { timeout: 15_000 }).toBeTruthy();
    const message = await lastEmailTo(email);
    expect(message?.subject).toBe("Confirm your email for Cable Billing");
    const link = message?.text.match(/https?:\/\/\S+\/verify\/([A-Za-z0-9_-]{43})/);
    expect(link).toBeTruthy();
    const verifyPath = `/verify/${link?.[1]}`;

    await page.goto(verifyPath);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Start Cable Billing");
    await expect(page.getByText(`E2E Cable ${run}`)).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");

    await page.getByLabel("Password (the one you chose)").fill("not my password");
    await page.getByRole("button", { name: "Start" }).click();
    await expect(formAlert(page)).toHaveText(
      "Wrong password. Type the password you chose when you created the account.",
    );

    await page.getByLabel("Password (the one you chose)").fill(PASSWORD);
    await page.getByRole("button", { name: "Start" }).click();
    await expect(page).toHaveURL(/\/home$/);
    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === "cb.session_token")).toMatchObject({ httpOnly: true });

    // Signed in: the sign-in page sends you home.
    await page.goto("/login");
    await expect(page).toHaveURL(/\/home$/);

    // The link is used up.
    await page.goto(verifyPath);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("This link does not work");

    // The tenant: active owner (email confirmed, mobile as user name), trialing for 30 days.
    const db = createDb({ connectionString: DATABASE_URL ?? "", max: 1 });
    try {
      // Platform role: users and subscriptions are readable there (T-021 policies).
      const found = await db.withPlatform(async (tx) => {
        const owner = await tx.query.users.findFirst({ where: (u, { eq }) => eq(u.email, email) });
        const subscription = owner?.operatorId
          ? await tx.query.subscriptions.findFirst({
              where: (s, { eq }) => eq(s.operatorId, owner.operatorId ?? ""),
            })
          : undefined;
        return { owner, subscription };
      });
      expect(found.owner).toMatchObject({
        login: mobile,
        emailVerified: true,
        role: "owner",
        status: "active",
      });
      expect(found.subscription?.status).toBe("trialing");
      const trialMs =
        (found.subscription?.trialEndsAt?.getTime() ?? 0) - (found.owner?.createdAt.getTime() ?? 0);
      expect(trialMs).toBeGreaterThanOrEqual(30 * 86_400_000);
      expect(trialMs).toBeLessThanOrEqual(31 * 86_400_000);
    } finally {
      await db.end();
    }
  });

  test("the sign-up page is bilingual and links to sign-in", async ({ page }) => {
    await page.goto("/signup");
    await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    await page.getByRole("button", { name: "हिंदी" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("अपना अकाउंट बनाएँ");
    await expect(page.getByLabel("मोबाइल नंबर")).toBeVisible();
  });
});
