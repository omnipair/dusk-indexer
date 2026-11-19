// Authenticated Vercel metadata only. Output contains public identities and exact origins, never credentials.
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { commandJson } from './aws-cli.mjs';
import { verifiedPreviewOrigins } from './register-preview.mjs';
const { values } = parseArgs({ options: { output: { type: 'string' } } });
if (!values.output) throw new Error('--output is required');
const projectId = 'prj_ztwzUn81e0xHqLa2NjoHbnqXy0EF';
const call = (path) =>
  commandJson('vercel', ['api', path, '--scope', 'omnipair']);
try {
  const ids = new Set();
  let until;
  do {
    const page = await call(
      `/v6/deployments?projectId=${projectId}&state=READY&target=preview&limit=100${until ? `&until=${until}` : ''}`,
    );
    for (const d of page.deployments ?? []) ids.add(d.uid ?? d.id);
    const next = page.pagination?.next;
    if (next && next === until) throw new Error('Pagination did not advance');
    until = next;
    if (ids.size > 10000) throw new Error('Preview registry capacity exceeded');
  } while (until);
  const records = [],
    list = [...ids];
  for (let i = 0; i < list.length; i += 4) {
    const batch = await Promise.all(
      list.slice(i, i + 4).map((id) => call('/v13/deployments/' + id)),
    );
    for (const d of batch) {
      if (d.readyState !== 'READY' || ![null, 'preview'].includes(d.target))
        continue;
      verifiedPreviewOrigins(`https://${d.url}`, d);
      records.push({
        id: d.id,
        name: d.name,
        url: d.url,
        alias: d.alias ?? [],
        createdAt: d.createdAt,
        readyState: d.readyState,
        target: d.target,
        projectId: d.projectId,
        ownerId: d.ownerId,
        team: { id: d.team.id },
        meta: Object.fromEntries(
          [
            'githubRepoId',
            'githubCommitOrg',
            'githubCommitRepo',
            'githubCommitSha',
          ].map((k) => [k, d.meta[k]]),
        ),
      });
    }
  }
  writeFileSync(values.output, JSON.stringify(records, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      verifiedDeployments: records.length,
      projectId,
      output: values.output,
    }),
  );
} catch {
  console.error(
    'Preview metadata capture failed; no credentials or provider details logged.',
  );
  process.exitCode = 1;
}
