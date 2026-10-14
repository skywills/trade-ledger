import { type AppContext, createApp } from "./app.js";
import { readConfig } from "./config.js";
import { shutdown } from "./maintenance/shutdown.js";

try {
  const config = readConfig(process.env);
  let context: AppContext | undefined;
  const app = await createApp(config, {
    onReady: (ready) => {
      context = ready;
    },
  });

  let closing = false;
  const graceful = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    if (context !== undefined) {
      await shutdown(context.store);
    }
    await app.close();
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      // A failed graceful shutdown must not report success: exit non-zero so
      // orchestrators can see that draining did not complete cleanly.
      void graceful().then(
        () => {
          process.exitCode = 0;
        },
        (error: unknown) => {
          process.stderr.write(
            `Failed to shut down the journal server cleanly: ${String(error)}\n`,
          );
          process.exitCode = 1;
        },
      );
    });
  }

  try {
    await app.listen({ host: "0.0.0.0", port: config.port });
  } catch (error) {
    app.log.error(error);
    await graceful();
    process.exitCode = 1;
  }
} catch (error) {
  // Covers configuration and startup-recovery failures before any listener.
  process.stderr.write(
    `Failed to start the journal server: ${String(error)}\n`,
  );
  process.exitCode = 1;
}
