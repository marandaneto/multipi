import { test, expect } from "@playwright/test";

test("two independent browsers share a durable attributed session and enforce revocation", async ({
  browser,
  request,
  baseURL,
}) => {
  const seeded = await (await request.get("/api/__test__/seed")).json();
  const alice = await browser.newContext({
    extraHTTPHeaders: { "x-multipi-dev-user": "alice@example.test" },
  });
  const bob = await browser.newContext({
    extraHTTPHeaders: { "x-multipi-dev-user": "bob@example.test" },
  });
  const a = await alice.newPage();
  const b = await bob.newPage();
  const errors: string[] = [];
  a.on("pageerror", (error) => errors.push(error.message));
  b.on("pageerror", (error) => errors.push(error.message));
  await a.goto(`${baseURL}/#/rooms/${seeded.id}`);
  await expect(
    a.getByText("Connected · synchronized", { exact: true }),
  ).toBeVisible();
  await a.getByLabel("Existing user's email").fill("bob@example.test");
  await a.getByRole("combobox").selectOption("observer");
  await a.getByRole("button", { name: "Update membership" }).click();
  await expect
    .poll(
      async () =>
        (await (await alice.request.get(`/api/rooms/${seeded.id}`)).json()).room
          .members["bob@example.test"],
    )
    .toBe("observer");
  await b.goto(`${baseURL}/#/rooms/${seeded.id}`);
  await expect(
    b.getByText("Connected · synchronized", { exact: true }),
  ).toBeVisible();
  await expect(
    b.getByRole("button", { name: "Send follow-up" }),
  ).toBeDisabled();
  await a.getByLabel("Message to Pi").fill("joint implementation");
  await a.getByRole("button", { name: "Send follow-up" }).click();
  await expect(
    b.locator("pre").filter({ hasText: "Fixture model: joint implementation" }),
  ).toHaveCount(1);
  await b.reload();
  await expect(
    b.getByText("Connected · synchronized", { exact: true }),
  ).toBeVisible();
  await expect(
    b.locator("pre").filter({ hasText: "Fixture model: joint implementation" }),
  ).toHaveCount(1);
  await a.getByLabel("Existing user's email").fill("bob@example.test");
  await a.getByRole("combobox").selectOption("remove");
  await a.getByRole("button", { name: "Update membership" }).click();
  await expect(
    b.getByText("Access denied; reload to authenticate", { exact: true }),
  ).toBeVisible();
  await expect(
    b.getByRole("button", { name: "Send follow-up" }),
  ).toBeDisabled();
  await b.reload();
  await expect(b.getByText("Not a room member", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  await alice.close();
  await bob.close();
});
