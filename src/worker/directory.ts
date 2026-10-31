import { DurableObject } from "cloudflare:workers";

export class DirectoryDO extends DurableObject {
  async add(id: string) {
    await this.ctx.storage.transaction(async (transaction) => {
      const ids = (await transaction.get<string[]>("rooms")) ?? [];
      if (ids.includes(id)) return;
      if (ids.length >= 100)
        throw new Error("Deployment pilot room limit reached");
      await transaction.put("rooms", [...ids, id]);
    });
  }
  async list() {
    return (await this.ctx.storage.get<string[]>("rooms")) ?? [];
  }
}
