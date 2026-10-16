import app from "./app";
import { logger } from "./lib/logger";
import { restoreArmedWatchers } from "./lib/watcher";
import { restoreArmedSafeguards } from "./lib/safeguardWatcher";
import { initAutoEntryWatcher } from "./lib/autoEntryWatcher";
import { positionTracker } from "./lib/positionTracker";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  await restoreArmedWatchers();
  await restoreArmedSafeguards();
  await initAutoEntryWatcher();

  // Restore position entry log from DB, then start background scanner.
  // Scanner detects positions opened externally (directly on Bitunix)
  // so every close path has entry-time oracle context available.
  await positionTracker.restore();
  positionTracker.startScanner("BTCUSDT");
});
