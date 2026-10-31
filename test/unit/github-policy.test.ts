import { expect, it } from "vitest";
import {
  preparePublish,
  type PublishManifest,
} from "../../src/github/index.js";

const manifest: PublishManifest = {
  roomId: "12345678-1234-4234-8234-123456789abc",
  repository: "acme/project",
  baseSha: "a".repeat(40),
  expectedHead: null,
  title: "Change",
  body: "",
  files: [{ path: "file", content: "text", mode: "100644" }],
};
const actor = { id: "u1", name: "Reviewer", email: "reviewer@example.com" };
it("preparePublish reserves reconciliation markers against user body injection", async () => {
  await expect(
    preparePublish(
      { ...manifest, body: `<!-- multipi-operation:${"a".repeat(64)} -->` },
      actor,
      "2026-01-02T03:04:05Z",
    ),
  ).rejects.toThrow("reserved");
});
it("preparePublish rejects unpaired Unicode in paths before Git UTF-8 replacement", async () => {
  await expect(
    preparePublish(
      {
        ...manifest,
        files: [{ path: "\ud800", content: "text", mode: "100644" }],
      },
      actor,
      "2026-01-02T03:04:05Z",
    ),
  ).rejects.toThrow("Unsupported file path");
});
