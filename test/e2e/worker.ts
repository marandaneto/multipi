import app from "../../src/worker/index";
import type { AppEnv } from "../../src/worker/env";
export {
  FixtureRoom,
  SpikeRoom,
  DirectoryDO,
  DirectoryBackupGateway,
  GitReadGateway,
  DependencyGateway,
} from "../workers/application";

export default {
  async fetch(request: Request, env: AppEnv) {
    if (new URL(request.url).pathname === "/api/__test__/seed") {
      const id = crypto.randomUUID();
      await env.ROOMS.getByName(id).initialize({
        id,
        title: "Shared browser task",
        repository: "org/repo",
        baseSha: "a".repeat(40),
        owner: "alice@example.test",
        createdAt: new Date().toISOString(),
      });
      await env.DIRECTORY.getByName("deployment").add(id);
      return Response.json({ id });
    }
    return app.fetch(request, env);
  },
};
