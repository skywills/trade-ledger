import { createApp } from "./app.js";
import { readConfig } from "./config.js";

try {
  const config = readConfig(process.env);
  const app = await createApp(config);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void app.close().finally(() => {
        process.exitCode = 0;
      });
    });
  }

  try {
    await app.listen({ host: "0.0.0.0", port: config.port });
  } catch (error) {
    app.log.error(error);
    await app.close();
    process.exitCode = 1;
  }
} catch (error) {
  // Covers configuration and startup-recovery failures before any listener.
  process.stderr.write(
    `Failed to start the journal server: ${String(error)}\n`,
  );
  process.exitCode = 1;
}
