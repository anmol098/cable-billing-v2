/**
 * Sign-in smoke tests (T-026) against `next start` and a real, migrated database.
 *
 * Needs `DATABASE_URL` (migrated: `pnpm --filter @cb/db db:migrate`) and `BETTER_AUTH_SECRET`
 * in the environment of both the test runner and the server (the CI "Web e2e" job sets them).
 * Each run seeds its own operator and users with random names, so runs don't collide.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { hashPassword } from "@cb/core";
import {
  accounts,
  createDb,
  type DbClient,
  operators,
  subscriptions,
  users,
  uuidv7,
  verifications,
} from "@cb/db";
import { expect, type Page, test } from "@playwright/test";
import { newSeedId } from "./_support/unique";

const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = "e2e password 4321";
const RATE_LIMIT_ATTEMPTS = 10; // AUTH_RATE_LIMITS.signInPerAccount.limit

test.describe("sign-in", () => {
  test.skip(!DATABASE_URL, "needs DATABASE_URL (a migrated database) and BETTER_AUTH_SECRET");

  // Made fresh in every beforeAll (see _support/unique.ts), so a second seed never collides.
  let run = "";
  const login = (who: string) => `e2e-${who}-${run}`;
  const email = (who: string) => `e2e-${who}-${run}@cable.test`;
  const ids: Record<string, string> = {};
  let db: DbClient;

  test.beforeAll(async () => {
    run = newSeedId();
    db = createDb({ connectionString: DATABASE_URL ?? "", max: 2 });
    const operatorId = uuidv7();
    const hash = await hashPassword(PASSWORD);
    const tenantUsers = [
      ["owner", "owner"],
      ["lineman", "lineman"],
      ["staff", "staff"],
      ["reset", "owner"],
      ["limited", "staff"],
    ] as const;
    await db.withTenant(operatorId, async (tx) => {
      await tx.insert(operators).values({ id: operatorId, name: `E2E Cable ${run}` });
      await tx.insert(subscriptions).values({
        operatorId,
        status: "active",
        trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
      });
      for (const [who, role] of tenantUsers) {
        const id = uuidv7();
        ids[who] = id;
        await tx.insert(users).values({
          id,
          operatorId,
          role,
          name: `E2E ${who}`,
          login: login(who),
          email: role === "lineman" ? null : email(who),
          language: "en",
        });
        await tx.insert(accounts).values({
          id: uuidv7(),
          userId: id,
          accountId: id,
          providerId: "credential",
          password: hash,
        });
      }
    });
    const adminId = uuidv7();
    ids.admin = adminId;
    await db.withPlatform(async (tx) => {
      await tx.insert(users).values({
        id: adminId,
        operatorId: null,
        role: "platform_admin",
        name: "E2E admin",
        login: login("admin"),
        email: email("admin"),
        language: "en",
      });
      await tx.insert(accounts).values({
        id: uuidv7(),
        userId: adminId,
        accountId: adminId,
        providerId: "credential",
        password: hash,
      });
    });
  });

  test.afterAll(async () => {
    await db?.end();
  });

  /** The form's error box (Next's route announcer also has role="alert"). */
  const formAlert = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');

  async function signIn(page: Page, who: string, password = PASSWORD) {
    await page.getByLabel("Mobile no., user name or email").fill(login(who));
    await page.getByLabel("Password", { exact: true }).fill(password);
    // Wait for the Server Action's answer, so the next step never races the form's reset.
    const answered = page.waitForResponse((r) => r.request().method() === "POST");
    await page.getByRole("button", { name: "Sign in" }).click();
    await answered;
  }

  test("protected pages send you to sign-in, which is bilingual, with Show/Hide", async ({
    page,
  }) => {
    await page.goto("/customers?q=ram");
    await expect(page).toHaveURL(/\/login\?next=%2Fcustomers%3Fq%3Dram$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);

    const password = page.getByLabel("Password", { exact: true });
    await password.fill("secret words");
    await expect(password).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "Show password" }).click();
    await expect(password).toHaveAttribute("type", "text");
    await page.getByRole("button", { name: "Hide password" }).click();
    await expect(password).toHaveAttribute("type", "password");

    await page.getByRole("button", { name: "हिंदी" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("लॉग इन");
    await expect(page.getByRole("button", { name: "लॉग इन करें" })).toBeVisible();
  });

  test("an owner signs in, goes where they were headed, with a safe session cookie", async ({
    page,
    context,
  }) => {
    await page.goto("/customers");
    await signIn(page, "owner");
    await expect(page).toHaveURL(/\/customers$/);
    const cookie = (await context.cookies()).find((c) => c.name === "cb.session_token");
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");
    expect((cookie?.expires ?? 0) * 1000 - Date.now()).toBeGreaterThan(29 * 86_400_000);

    // Signed in: the login page sends you home (role routing: owner → /home).
    await page.goto("/login");
    await expect(page).toHaveURL(/\/home$/);
  });

  test("one message for a wrong password; linemen are sent to the phone app", async ({ page }) => {
    await page.goto("/login");
    await signIn(page, "staff", "not the password");
    await expect(formAlert(page)).toHaveText("Wrong user name or password.");
    await expect(page.getByLabel("Mobile no., user name or email")).toHaveValue(login("staff"));

    await page.goto("/login");
    await signIn(page, "nobody-at-all", PASSWORD);
    await expect(formAlert(page)).toHaveText("Wrong user name or password.");

    await page.goto("/login");
    await signIn(page, "lineman");
    await expect(formAlert(page)).toContainText("This login is for the phone app");
    await expect(page).toHaveURL(/\/login$/);
    expect((await page.context().cookies()).some((c) => c.name === "cb.session_token")).toBe(false);
  });

  test("too many wrong passwords → wait (even the right one is refused)", async ({ page }) => {
    await page.goto("/login");
    for (let i = 0; i < RATE_LIMIT_ATTEMPTS; i += 1) {
      await signIn(page, "limited", `wrong ${i}`);
      await expect(formAlert(page)).toHaveText("Wrong user name or password.");
      // Every answer shows the same words, so also wait for the form's reset (it clears the
      // password) before typing the next try; typing earlier gets wiped by that reset.
      await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
    }
    await signIn(page, "limited", PASSWORD);
    await expect(formAlert(page)).toContainText("Too many tries");
  });

  test("password reset: same answer for any address; the link works once", async ({ page }) => {
    for (const address of [email("reset"), `nobody-${run}@cable.test`]) {
      await page.goto("/reset");
      await page.getByLabel("Email").fill(address);
      await page.getByRole("button", { name: "Send link" }).click();
      await expect(page.getByRole("status")).toContainText("If this email has an account");
    }

    // The emailed link's token, stored the way Better Auth stores it (hashed identifier).
    const token = randomBytes(18).toString("base64url");
    const identifier = createHash("sha256").update(`reset-password:${token}`).digest("base64url");
    await db.withPlatform((tx) =>
      tx.insert(verifications).values({
        id: uuidv7(),
        identifier,
        value: ids.reset ?? "",
        expiresAt: new Date(Date.now() + 3_600_000),
      }),
    );
    const newPassword = "my new e2e password";
    await page.goto(`/reset/${token}`);
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
    await page.getByLabel("New password", { exact: true }).fill(newPassword);
    await page.getByLabel("New password again").fill(newPassword);
    await page.getByRole("button", { name: "Save password" }).click();
    await expect(page).toHaveURL(/\/login\?notice=password_changed$/);
    await expect(page.getByRole("status")).toContainText("Password changed");

    await signIn(page, "reset", newPassword);
    await expect(page).toHaveURL(/\/home$/);

    // Second use of the same link.
    await page.context().clearCookies();
    await page.goto(`/reset/${token}`);
    await page.getByLabel("New password", { exact: true }).fill("yet another password");
    await page.getByLabel("New password again").fill("yet another password");
    await page.getByRole("button", { name: "Save password" }).click();
    await expect(formAlert(page)).toContainText("This link does not work any more");
  });

  test("a platform admin must turn on 2-step sign-in, then needs the code", async ({ page }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/login\?next=%2Fadmin$/);
    await signIn(page, "admin");
    await expect(page).toHaveURL(/\/login\/2fa\/setup$/);
    await page.getByLabel("Your password").fill(PASSWORD);
    await page.getByRole("button", { name: "Next" }).click();
    const secret = (await page.getByTestId("totp-secret").textContent())?.trim() ?? "";
    expect(secret).toMatch(/^[A-Z2-7]+=*$/);
    await page.getByLabel("6-digit code from the app").fill(totp(secret));
    await page.getByRole("button", { name: "Turn on" }).click();
    await expect(page).toHaveURL(/\/admin$/);

    await page.context().clearCookies();
    await page.goto("/login");
    await signIn(page, "admin");
    await expect(page).toHaveURL(/\/login\/2fa$/);
    await page.getByLabel("6-digit code").fill("000000");
    await page.getByRole("button", { name: "Check code" }).click();
    await expect(formAlert(page)).toContainText("Wrong code");
    await page.getByLabel("6-digit code").fill(totp(secret));
    await page.getByRole("button", { name: "Check code" }).click();
    await expect(page).toHaveURL(/\/admin$/);
  });
});

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) from a base32 secret. */
function totp(base32Secret: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of base32Secret.replace(/=+$/, "")) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
