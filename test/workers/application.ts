import worker from "../../src/worker/index";
import { RoomDO, type RoomWorkspace } from "../../src/room/room";
export { SpikeRoom } from "./spike";
export { DirectoryDO } from "../../src/worker/directory";
export {
  DirectoryBackupGateway,
  GitReadGateway,
  DependencyGateway,
} from "../../src/worker/index";

export class FixtureRoom extends RoomDO {
  private fixtureWorkspace?: RoomWorkspace;
  transitionWorkspace(stage: "restoring" | "ready" | "failed") {
    return this.workspaceTransition(stage);
  }
  override workspace(): RoomWorkspace {
    return (this.fixtureWorkspace ??= {
      env: undefined,
      attach() {},
      async ensure() {},
      async initialize() {
        return { revision: 1, backupKey: "fixture", digest: "fixture" };
      },
      async checkpoint() {
        throw new Error(
          "Coding tools are not supported by the room-control fixture",
        );
      },
      async stop() {},
      async restore() {},
      async review() {
        return { revision: 1, digest: "a".repeat(64), patch: "", files: [] };
      },
    });
  }
}
export default worker;
