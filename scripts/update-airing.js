/**
 * Backwards-compatible wrapper.
 *
 * The scheduled updater is now scripts/smart-update.js, but this file keeps
 * the old npm script and any existing manual commands working.
 */
import { runSmartUpdate } from './smart-update.js';

try {
  await runSmartUpdate();
} catch (err) {
  console.error(`update-airing: ${err.message}`);
  process.exit(1);
}
