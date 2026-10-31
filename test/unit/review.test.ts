import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  chmodSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildReview,
  captureSchema,
  captureScript,
} from "../../src/workspace/review";

describe("immutable raw-byte review", () => {
  it("cannot hide raw changes with checkout-controlled textconv and preserves executable deletion", () => {
    const dir = mkdtempSync(join(tmpdir(), "multipi-review-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    try {
      git("init", "-q");
      git("config", "user.email", "fixture@example.test");
      git("config", "user.name", "Fixture");
      git("config", "commit.gpgsign", "false");
      writeFileSync(join(dir, "file.txt"), "original\n");
      writeFileSync(join(dir, "run.sh"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(dir, "run.sh"), 0o755);
      git("add", ".");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD").trim();
      mkdirSync(join(dir, ".git", "info"), { recursive: true });
      writeFileSync(
        join(dir, ".git", "info", "attributes"),
        "file.txt diff=hide\n",
      );
      git("config", "diff.hide.textconv", "printf benign");
      writeFileSync(join(dir, "file.txt"), "raw changed content\n");
      unlinkSync(join(dir, "run.sh"));
      expect(git("diff", base, "--", "file.txt")).not.toContain(
        "raw changed content",
      );
      const capture = captureSchema.parse(
        JSON.parse(
          execFileSync(
            process.execPath,
            ["--input-type=module", "-e", captureScript, base],
            { cwd: dir, encoding: "utf8" },
          ),
        ),
      );
      const review = buildReview(capture);
      expect(review.patch).toContain("+raw changed content");
      expect(review.patch).toContain("-original");
      expect(review.files.find((file) => file.path === "run.sh")).toEqual({
        path: "run.sh",
        content: null,
        mode: "100755",
      });
      expect(review.patch).toContain("deleted file mode 100755");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
