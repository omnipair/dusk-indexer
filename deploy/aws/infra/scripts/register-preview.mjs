import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commandJson } from './aws-cli.mjs';

const projectId = 'prj_ztwzUn81e0xHqLa2NjoHbnqXy0EF';
const teamId = 'team_mUKFDc1HjGHQuYhtdIuDIh0x';
const repositoryId = '1335314663';

function exactOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.hostname.includes('*'))
    throw new Error('Expected an exact HTTPS origin');
  return url;
}

export function verifiedPreviewOrigins(origin, deployment) {
  const url = exactOrigin(origin);
  if (deployment.projectId !== projectId || deployment.ownerId !== teamId
    || deployment.team?.id !== teamId || deployment.name !== 'dusk-webapp'
    || deployment.meta?.githubRepoId !== repositoryId
    || deployment.meta?.githubCommitOrg !== 'omnipair'
    || deployment.meta?.githubCommitRepo !== 'dusk-webapp')
    throw new Error('Preview is not owned by the approved Dusk project and repository');
  if (deployment.readyState !== 'READY' || ![null, 'preview'].includes(deployment.target)
    || !deployment.meta.githubCommitRef || !/^[a-f0-9]{40}$/.test(deployment.meta.githubCommitSha))
    throw new Error('Expected a ready Git preview deployment');
  if (![deployment.url, ...(deployment.alias ?? [])].includes(url.host))
    throw new Error('Origin does not belong to the verified deployment');
  const immutableOrigin = `https://${deployment.url}`;
  exactOrigin(immutableOrigin);
  if (!url.hostname.endsWith('.vercel.app') || !new URL(immutableOrigin).hostname.endsWith('.vercel.app'))
    throw new Error('Expected a verified Vercel preview hostname');
  return [...new Set([origin, immutableOrigin])];
}

export async function registerPreviews(args) {
  const origins = [];
  let write = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--origin' && args[i + 1]) origins.push(args[++i]);
    else if (args[i] === '--write') write = true;
    else throw new Error('Usage: register-preview.mjs --origin https://preview.vercel.app [--origin ...] [--write]');
  }
  if (!origins.length) throw new Error('At least one --origin is required');
  const configPath = process.env.DUSK_AWS_CONFIG ?? new URL('../release.config.json', import.meta.url);
  const before = readFileSync(configPath, 'utf8');
  const config = JSON.parse(before);
  const existing = config.browserOrigins ?? ['https://beta.omnipair.fi'];
  if (!Array.isArray(existing) || !existing.length) throw new Error('Invalid existing browser origins');
  existing.forEach(exactOrigin);
  const verified = [];
  for (const origin of origins) {
    const url = exactOrigin(origin);
    const deployment = await commandJson('vercel', ['api', `/v13/deployments/${encodeURIComponent(url.host)}`, '--scope', 'omnipair']);
    verified.push({
      origins: verifiedPreviewOrigins(origin, deployment),
      deploymentId: deployment.id,
      branch: deployment.meta.githubCommitRef,
      commit: deployment.meta.githubCommitSha,
    });
  }
  const next = [...new Set([...existing, ...verified.flatMap(value => value.origins)])];
  const addedOrigins = next.filter(origin => !existing.includes(origin));
  if (write && addedOrigins.length) {
    if (readFileSync(configPath, 'utf8') !== before) throw new Error('Configuration changed during verification; retry');
    const temporary = `${configPath instanceof URL ? configPath.pathname : configPath}.preview-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify({ ...config, browserOrigins: next }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, configPath);
  }
  console.log(JSON.stringify({ mode: write ? 'local-config-only' : 'dry-run', addedOrigins, verified }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  registerPreviews(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
