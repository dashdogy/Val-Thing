import { ValBridgeServer } from "./server.js";
import { repairInstalledLaunchHandler } from "./launch-handler-repair.js";

await repairInstalledLaunchHandler();
let server: ValBridgeServer | undefined;
let shutdownStarted = false;

const shutdown = async () => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  await server?.close();
  process.exitCode = 0;
};

server = await ValBridgeServer.create({
  onUpdateRequested: () => {
    void shutdown();
  },
});

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

await server.listen();
