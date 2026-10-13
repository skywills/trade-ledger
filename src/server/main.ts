import { createApp } from "./app.js";
import { readConfig } from "./config.js";

const config = readConfig(process.env);
const app = await createApp(config);

try {
  await app.listen({ host: "0.0.0.0", port: config.port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().finally(() => {
      process.exitCode = 0;
    });
  });
}
