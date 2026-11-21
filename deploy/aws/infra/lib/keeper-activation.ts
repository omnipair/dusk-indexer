import { keeperExecutionEnvironment } from './keeper-execution.js';

const profiles = ['lending','leverage','hlp-recovery','auction-arbitrage','lifecycle','sentinel'];
type Template = { Parameters?: Record<string,any>; Resources: Record<string,any>; [key:string]:any };

/** Patch a fetched stack template without resynthesizing unrelated production resources. */
export function prepareKeeperActivation(source: Template) {
  const template = structuredClone(source);
  const tasks = new Map<string,{ id:string; profile:string; container:any }>();
  for (const [id, resource] of Object.entries(template.Resources)) {
    if (resource.Type !== 'AWS::ECS::TaskDefinition') continue;
    const containers = resource.Properties.ContainerDefinitions;
    const container = containers.find((c:any)=>c.Environment?.some((e:any)=>e.Name==='KEEPER_PROFILE'));
    if (!container) continue;
    const environment = Object.fromEntries(container.Environment.map((e:any)=>[e.Name,e.Value]));
    const profile = environment.KEEPER_PROFILE;
    if (containers.length !== 1 || !profiles.includes(profile) || [...tasks.values()].some(t=>t.profile===profile))
      throw new Error('Unexpected or duplicate keeper task');
    if (environment.DUSK_CLUSTER !== 'mainnet-beta' || environment.KEEPER_MODE !== 'shadow')
      throw new Error('Prepare activation only from the verified mainnet shadow configuration');
    if (profile === 'hlp-recovery' && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(environment.KEEPER_HLP_MARKET ?? ''))
      throw new Error('An explicit hLP market is required');
    if (profile !== 'sentinel' && (environment.SIGNER_PROVIDER !== 'aws-kms' || !environment.SIGNER_KEY_ID || !environment.KEEPER_SIGNER_PUBLIC_KEY))
      throw new Error('Existing per-profile KMS identity is required');
    const updates = { ...keeperExecutionEnvironment(profile), KEEPER_MODE: { Ref:'KeeperMode' } };
    container.Environment = [
      ...container.Environment.filter((e:any)=>!(e.Name in updates)),
      ...Object.entries(updates).map(([Name,Value])=>({Name,Value})),
    ];
    tasks.set(id,{id,profile,container});
  }
  if (tasks.size !== profiles.length) throw new Error('Expected exactly six keeper profiles');
  if (template.Parameters?.KeeperMode) throw new Error('KeeperMode already exists; review the current operator configuration');
  template.Parameters ??= {};
  template.Parameters.KeeperMode = {
    Type:'String', Default:'shadow', AllowedValues:['shadow','live'],
    Description:'Explicit operator activation after execution, journal and signer checks; sentinel remains monitoring-only',
  };
  const services = new Set<string>();
  for (const [id, resource] of Object.entries(template.Resources)) {
    if (resource.Type !== 'AWS::ECS::Service' || !tasks.has(resource.Properties.TaskDefinition?.Ref)) continue;
    if (resource.Properties.DesiredCount !== 1) throw new Error('Unexpected keeper replica count');
    resource.Properties.DeploymentConfiguration.MinimumHealthyPercent = 0;
    resource.Properties.DeploymentConfiguration.MaximumPercent = 100;
    services.add(id);
  }
  if (services.size !== profiles.length) throw new Error('Expected exactly six keeper services');
  return { template, resources:[...tasks.keys(),...services], profiles:[...tasks.values()].map(t=>t.profile) };
}
