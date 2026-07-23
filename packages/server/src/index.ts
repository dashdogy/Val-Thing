import { ValBridgeServer } from "./server.js";

const server = await ValBridgeServer.create();

const shutdown = async () => {
  await server.close();
  process.exitCode = 0;
};

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

await server.listen();
