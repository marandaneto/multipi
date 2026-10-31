import type { RoomDO } from "../room/room";
import type { DirectoryDO } from "./directory";
import type { AuthConfig } from "./auth";

export interface AppEnv extends AuthConfig {
  ROOMS: DurableObjectNamespace<RoomDO>;
  DIRECTORY: DurableObjectNamespace<DirectoryDO>;
  BACKUPS: R2Bucket;
  ASSETS: Fetcher;
  AI?: Ai;
  MODEL_ID?: string;
  MAX_ROOM_TOKENS?: string;
  MAX_ROOM_COST_USD?: string;
  WORKSPACE_INSTANCE_TYPE?: string;
  ALLOWED_REPOSITORIES?: string;
  GITHUB_APP_ID?: string;
  GITHUB_INSTALLATION_ID?: string;
  GITHUB_PRIVATE_KEY?: string;
}
declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./index");
      durableNamespaces: "RoomDO" | "DirectoryDO";
    }
  }
}
