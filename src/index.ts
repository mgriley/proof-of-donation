import { loadConfig } from './config.js';
import { loadPlugins } from './plugins/loader.js';
import { createServer } from './server.js';

async function main() {
  const config = loadConfig();

  const plugins = await loadPlugins({ pluginDirs: config.pluginDirs });

  if (plugins.length === 0) {
    console.warn('Warning: no receipt plugins are enabled -- every /verify request will fail.');
  } else {
    console.log(`Loaded plugins: ${plugins.map((p) => p.id).join(', ')}`);
  }

  const app = createServer(plugins);

  const server = app.listen(config.port, () => {
    console.log(`proof-of-donation listening on http://localhost:${config.port}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error starting proof-of-donation:', err);
  process.exit(1);
});
