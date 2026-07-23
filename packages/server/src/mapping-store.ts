import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "./json-file.js";

export type ResponseMapping = {
  responseId: string;
  chatId: string;
  createdAt: number;
};

type MappingFile = {
  version: 1;
  mappings: ResponseMapping[];
};

export class MappingStore {
  private readonly path: string;
  private mappings = new Map<string, ResponseMapping>();

  private constructor(path: string) {
    this.path = path;
  }

  static async open(configDirectory: string) {
    const store = new MappingStore(
      join(configDirectory, "response-mappings.json"),
    );
    try {
      const file = JSON.parse(
        await readFile(store.path, "utf8"),
      ) as MappingFile;
      for (const mapping of file.mappings ?? []) {
        if (mapping.responseId && mapping.chatId) {
          store.mappings.set(mapping.responseId, mapping);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    return store;
  }

  get(responseId: string) {
    return this.mappings.get(responseId);
  }

  async set(responseId: string, chatId: string) {
    this.mappings.set(responseId, {
      responseId,
      chatId,
      createdAt: Math.floor(Date.now() / 1000),
    });

    const retained = [...this.mappings.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, 1_000);
    this.mappings = new Map(
      retained.map((mapping) => [mapping.responseId, mapping]),
    );

    const file: MappingFile = { version: 1, mappings: retained };
    await writeJsonAtomic(this.path, file);
  }
}
