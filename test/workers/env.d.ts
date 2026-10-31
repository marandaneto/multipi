import type { SpikeRoom } from "./spike";
import type { AppEnv } from "../../src/worker/env";
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      SPIKE: DurableObjectNamespace<SpikeRoom>;
    }
  }
}
export {};
