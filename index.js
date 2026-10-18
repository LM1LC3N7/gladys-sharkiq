// -----------------------------------------------------------------------------
// Entry point: SDK bootstrap only. The handlers (src/handlers.js) are
// registered BEFORE connect(), and delegate to the SharkApp (src/app.js).
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { SharkApp } from './src/app.js';
import { registerHandlers } from './src/handlers.js';

const gladys = new GladysIntegration();
const app = new SharkApp({ gladys, logger });
registerHandlers(gladys, app, logger);

gladys.handleShutdown(() => app.stop());

logger.info('Starting the Shark IQ integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
