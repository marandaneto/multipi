import { env } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import app from "../../src/worker/index";

it("records safe failure stages without logging credentials or request content", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await app.fetch(
      new Request("http://localhost/api/rooms", {
        method: "POST",
        headers: {
          Origin: "http://localhost",
          "Content-Type": "application/json",
          "x-multipi-dev-user": "owner@example.test",
        },
        body: JSON.stringify({
          title: "private task title",
          repository: "fixture/repo",
          baseSha: "a".repeat(40),
        }),
      }),
      {
        ...env,
        ALLOWED_REPOSITORIES: '{"fixture/repo":["owner@example.test"]}',
        GITHUB_APP_ID: "1",
        GITHUB_INSTALLATION_ID: "1",
        GITHUB_PRIVATE_KEY: "private signing material",
      },
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Request failed; check room diagnostics",
    });
    expect(logged).toHaveBeenCalledOnce();
    const record = JSON.parse(String(logged.mock.calls[0]?.[0]));
    expect(record).toMatchObject({
      component: "worker",
      phase: "repository_resolution",
      category: "type_error",
    });
    expect(JSON.stringify(record)).not.toMatch(
      /private signing material|private task title|owner@example.test|fixture\/repo/,
    );
  } finally {
    logged.mockRestore();
  }
});
