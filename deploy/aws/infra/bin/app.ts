import { App, Tags } from 'aws-cdk-lib';
import { readFileSync } from 'node:fs';
import { loadParity, validateConfig, type ReleaseConfig } from '../lib/config.js';
import { NetworkStack, PeeringStack, WestRoutesStack } from '../lib/network.js';
import { DatabaseStack } from '../lib/database.js';
import { RegistryStack, RuntimeSecretsStack, ServicesStack } from '../lib/services.js';
import { AlertsStack } from '../lib/alerts.js';

const app = new App();
const configPath = process.env.DUSK_AWS_CONFIG ?? new URL('../release.config.json', import.meta.url);
const config = JSON.parse(readFileSync(configPath, 'utf8')) as ReleaseConfig;
validateConfig(config);
const parity = loadParity();
const common = { crossRegionReferences: true, terminationProtection: true };
const primaryEnv = { account: config.account, region: config.primaryRegion };
const westEnv = { account: config.account, region: config.indexerRegion };
const primary = new NetworkStack(app, 'DuskNetworkSingapore', { ...common, env: primaryEnv, primary: true });
const west = new NetworkStack(app, 'DuskNetworkOregon', { ...common, env: westEnv, primary: false });
const alerts = new AlertsStack(app, 'DuskAlertsSingapore', { ...common, env: primaryEnv, primary: true });
const westAlerts = new AlertsStack(app, 'DuskAlertsOregon', { ...common, env: westEnv, primary: false });
const peering = new PeeringStack(app, 'DuskPeeringSingapore', { ...common, env: primaryEnv, primary, west });
const routes = new WestRoutesStack(app, 'DuskPeeringOregon', { ...common, env: westEnv, west, peering });
const database = new DatabaseStack(app, 'DuskDatabase', { ...common, env: primaryEnv, primary, west, parity });
alerts.attachTo(database);
const registry = new RegistryStack(app, 'DuskRegistry', { ...common, env: primaryEnv });
const mainServices = parity.services.filter(s => !['timescaledb', 'dusk-indexer'].includes(s.name));
const indexerServices = parity.services.filter(s => s.name === 'dusk-indexer');
const mainSecrets = new RuntimeSecretsStack(app, 'DuskSecretsSingapore', { ...common, env: primaryEnv, services: mainServices });
const westSecrets = new RuntimeSecretsStack(app, 'DuskSecretsOregon', { ...common, env: westEnv, services: indexerServices });

// Foundation creation and secret/image preparation precede task creation.
// Runtime custody and protocol checks remain enforced by the keeper binary.
if (app.node.tryGetContext('services') === true || app.node.tryGetContext('services') === 'true') {
  const fleet = new ServicesStack(app, 'DuskServicesSingapore', { ...common, env: primaryEnv, network: primary, registry, runtimeSecrets: mainSecrets, specs: mainServices, parity, config, primary: true });
  const indexer = new ServicesStack(app, 'DuskIndexerOregon', { ...common, env: westEnv, network: west, registry, runtimeSecrets: westSecrets, specs: indexerServices, parity, config, primary: false });
  fleet.addStackDependency(database);
  fleet.addStackDependency(peering);
  indexer.addStackDependency(database);
  indexer.addStackDependency(routes);
  alerts.attachTo(fleet);
  westAlerts.attachTo(indexer);
}
Tags.of(app).add('Project', 'Dusk');
Tags.of(app).add('Environment', 'mainnet');
for (const stack of app.node.children) {
  if ('templateOptions' in stack) {
    const options = stack.templateOptions as { description?: string };
    options.description = 'Dusk mainnet Railway service parity: existing Helius, one instance per service, TimescaleDB, encrypted backups and isolated keeper IAM roles.';
  }
}
