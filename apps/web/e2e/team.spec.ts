/**
 * Settings → Staff and linemen (T-032) against `next start` and a real, migrated database: the
 * Owner adds a lineman (user name = mobile, password shown), shares the sign-in on WhatsApp (the
 * link has the user name and app link, never the password; we only say "WhatsApp opened"), the
 * lineman's phone signs in through the real mobile API and shows up on the page, the Owner sets a
 * new password (the phone's refresh fails, the new password works), signs the phone out, and
 * switches the lineman off (refresh fails, sign-in refused, nothing deleted). Staff get a 404.
 *
 * Needs `DATABASE_URL` (migrated) and `BETTER_AUTH_SECRET`, like `shell.spec.ts`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { ErrorResponse, LoginResponse } from "@cb/contracts";
import { hashPassword } from "@cb/core";
import { accounts, createDb, type DbClient, operators, subscriptions, users, uuidv7 } from "@cb/db";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";

const DATABASE_URL = process.env.DATABASE_URL;
const OWNER_PASSWORD = "e2e team owner 4321";
const LINEMAN_PASSWORD = "river 2468";
const NEW_PASSWORD = "mango 1357";
const API = "/api/mobile/v1";

test.describe("team: staff and linemen", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!DATABASE_URL, "needs DATABASE_URL (a migrated database) and BETTER_AUTH_SECRET");

  const run = randomBytes(4).toString("hex");
  const business = `Team Cable ${run}`;
  const login = (who: string) => `e2e-team-${who}-${run}`;
  // A fresh mobile per run: sign-in names are unique across every business.
  const mobile = `9${String(Number.parseInt(run, 16) % 1_000_000_000).padStart(9, "0")}`;
  const ip = `203.0.113.${(Number.parseInt(run.slice(0, 2), 16) % 200) + 30}`;
  const apiHeaders = { "x-app-version-code": "5", "x-real-ip": ip };
  let db: DbClient;
  let operatorId: string;

  test.beforeAll(async () => {
    db = createDb({ connectionString: DATABASE_URL ?? "", max: 2 });
    operatorId = uuidv7();
    const hash = await hashPassword(OWNER_PASSWORD);
    await db.withTenant(operatorId, async (tx) => {
      await tx.insert(operators).values({ id: operatorId, name: business });
      await tx.insert(subscriptions).values({
        operatorId,
        status: "active",
        trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
      });
      for (const role of ["owner", "staff"] as const) {
        const id = uuidv7();
        await tx.insert(users).values({
          id,
          operatorId,
          role,
          name: `E2E ${role}`,
          login: login(role),
          email: `${login(role)}@cable.test`,
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
  });

  test.afterAll(async () => {
    await db?.end();
  });

  async function signIn(page: Page, who: string) {
    await page.goto("/login");
    await page.getByLabel("Mobile no., user name or email").fill(login(who));
    await page.getByLabel("Password", { exact: true }).fill(OWNER_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/home$/);
  }

  async function phoneLogin(request: APIRequestContext, password: string, installId: string) {
    return request.post(`${API}/auth/login`, {
      headers: apiHeaders,
      data: {
        login: mobile,
        password,
        device: {
          install_id: installId,
          model: "Xiaomi Redmi 9A",
          os: "Android 13 (API 33)",
          app_version: "1.0.3",
          app_version_code: 5,
        },
      },
    });
  }

  async function refresh(request: APIRequestContext, refreshToken: string, installId: string) {
    return request.post(`${API}/auth/refresh`, {
      headers: apiHeaders,
      data: { refresh_token: refreshToken, install_id: installId },
    });
  }

  async function errorCode(response: Awaited<ReturnType<APIRequestContext["post"]>>) {
    return ErrorResponse.parse(await response.json()).error.code;
  }

  test("staff can't open the team page", async ({ page }) => {
    await signIn(page, "staff");
    const response = await page.goto("/settings/team");
    expect(response?.status()).toBe(404);
  });

  test("the Owner adds a lineman, shares the sign-in, sets a new password, signs the phone out and switches the lineman off", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    // WhatsApp is outside the test: answer wa.me locally.
    await page
      .context()
      .route("https://wa.me/**", (route) =>
        route.fulfill({ status: 200, contentType: "text/plain", body: "wa.me stub" }),
      );
    await signIn(page, "owner");
    await page.goto("/settings/team");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Staff and linemen");
    await expect(page.getByText("No linemen yet. Add your first lineman.")).toBeVisible();

    // Add the lineman: the user name follows the mobile, the password is shown.
    await page.getByRole("button", { name: "Add lineman" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name", { exact: true }).fill("Ravi Kumar");
    await dialog.getByLabel("Mobile no.", { exact: true }).fill(`+91 ${mobile}`);
    await expect(dialog.getByLabel("User name", { exact: true })).toHaveValue(mobile);
    const password = dialog.getByLabel("Password", { exact: true });
    await expect(password).toHaveAttribute("type", "text");
    await password.fill("123456");
    await dialog.getByRole("button", { name: "Add lineman" }).click();
    await expect(
      dialog.getByText("This password is too easy to guess.", { exact: false }),
    ).toBeVisible();
    await password.fill(LINEMAN_PASSWORD);
    await dialog.getByRole("button", { name: "Add lineman" }).click();
    await expect(dialog.getByText("Ravi Kumar is added")).toBeVisible();
    await expect(dialog.getByTestId("added-login")).toHaveText(mobile);

    // Share on WhatsApp: user name and app link, never the password.
    const share = dialog.getByRole("link", { name: "Share Ravi Kumar's sign-in on WhatsApp" });
    const href = (await share.getAttribute("href")) ?? "";
    expect(href.startsWith(`https://wa.me/91${mobile}?text=`)).toBe(true);
    const text = decodeURIComponent(href.split("?text=")[1] ?? "");
    expect(text).toContain(mobile);
    expect(text).toContain("play.google.com");
    expect(text).not.toContain(LINEMAN_PASSWORD);
    const popup = page.waitForEvent("popup");
    await share.click();
    await (await popup).close();
    await expect(page.getByText("WhatsApp opened", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Done" }).click();

    const card = page.locator('[data-member="Ravi Kumar"]');
    await expect(card.getByText("Not signed in on any phone yet.")).toBeVisible();

    // The lineman's phone signs in through the real mobile API.
    const installId = randomUUID();
    const first = await phoneLogin(request, LINEMAN_PASSWORD, installId);
    expect(first.status()).toBe(200);
    const firstBody = LoginResponse.parse(await first.json());
    await page.reload();
    await expect(card.getByText(`Xiaomi Redmi 9A (${firstBody.device.device_code})`)).toBeVisible();
    await expect(card.getByText("Signed in")).toBeVisible();

    // New password: the phone's refresh fails; the old password is dead, the new one works.
    await card.getByRole("button", { name: "New password for Ravi Kumar" }).click();
    const reset = page.getByRole("dialog");
    await reset.getByLabel("Password", { exact: true }).fill(NEW_PASSWORD);
    await reset.getByRole("button", { name: "Save new password" }).click();
    await expect(reset.getByText("New password saved")).toBeVisible();
    await reset.getByRole("button", { name: "Done" }).click();
    const afterReset = await refresh(request, firstBody.tokens.refresh_token, installId);
    expect(afterReset.status()).toBe(401);
    expect(await errorCode(afterReset)).toBe("REFRESH_TOKEN_INVALID");
    expect((await phoneLogin(request, LINEMAN_PASSWORD, installId)).status()).toBe(401);
    const second = await phoneLogin(request, NEW_PASSWORD, installId);
    expect(second.status()).toBe(200);
    const secondBody = LoginResponse.parse(await second.json());

    // Sign out this phone: its refresh gets DEVICE_REVOKED.
    await page.reload();
    await card.getByRole("button", { name: "Sign out this phone" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Sign out phone" }).click();
    await expect(page.getByText("Phone signed out.", { exact: true })).toBeVisible();
    const afterSignOut = await refresh(request, secondBody.tokens.refresh_token, installId);
    expect(afterSignOut.status()).toBe(401);
    expect(await errorCode(afterSignOut)).toBe("DEVICE_REVOKED");

    // The phone signs in again, then the Owner switches the lineman off.
    const third = LoginResponse.parse(
      await (await phoneLogin(request, NEW_PASSWORD, installId)).json(),
    );
    await page.reload();
    await card.getByRole("button", { name: "Switch off Ravi Kumar" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(
      confirm.getByText("Payments still saved on the phone are not lost", { exact: false }),
    ).toBeVisible();
    await confirm.getByRole("button", { name: "Switch off" }).click();
    await expect(page.getByText("Ravi Kumar is switched off.", { exact: true })).toBeVisible();
    await expect(card.getByText("Switched off")).toBeVisible();
    const afterOff = await refresh(request, third.tokens.refresh_token, installId);
    expect(afterOff.status()).toBe(401);
    const blocked = await phoneLogin(request, NEW_PASSWORD, installId);
    expect(blocked.status()).toBe(403);
    expect(await errorCode(blocked)).toBe("ACCOUNT_DISABLED");

    // Nothing deleted; the audit trail never holds a password.
    const state = await db.withTenant(operatorId, (tx) =>
      tx.query.users.findFirst({
        columns: { status: true, login: true },
        where: (u, { eq }) => eq(u.login, mobile),
      }),
    );
    expect(state).toEqual({ status: "disabled", login: mobile });
    const audit = await db.withTenant(operatorId, (tx) =>
      tx.query.auditEvents.findMany({ columns: { action: true, before: true, after: true } }),
    );
    const actions = audit.map((event) => event.action);
    for (const action of [
      "team.add_lineman",
      "team.reset_password",
      "devices.revoke",
      "team.deactivate",
    ]) {
      expect(actions).toContain(action);
    }
    const auditText = JSON.stringify(audit);
    for (const secret of [LINEMAN_PASSWORD, NEW_PASSWORD, "$argon2"]) {
      expect(auditText).not.toContain(secret);
    }
  });
});
