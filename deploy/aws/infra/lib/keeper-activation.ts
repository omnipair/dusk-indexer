import { keeperExecutionEnvironment } from './keeper-execution.js';

const profiles = ['lending','leverage','hlp-recovery','auction-arbitrage','lifecycle','sentinel'];
type Template = { Parameters?: Record<string,any>; Resources: Record<string,any>; [key:string]:any };
type StackParameter = { ParameterKey: string; ResolvedValue?: string };

/** Patch a fetched stack template without resynthesizing unrelated production resources. */
export function prepareKeeperActivation(source: Template, parameters: StackParameter[] = []) {
  const template = structuredClone(source);
  const pinnedHostImages: { resource:string; imageId:string }[] = [];
  // UsePreviousValue retains an SSM key, not its last resolved value. Pin the
  // deployed image here so a keeper-only update cannot silently upgrade hosts.
  for (const [id, resource] of Object.entries(template.Resources)) {
    if (resource.Type !== 'AWS::EC2::LaunchTemplate') continue;
    const ref = resource.Properties.LaunchTemplateData.ImageId?.Ref;
    if (!ref || template.Parameters?.[ref]?.Type !== 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>') continue;
    const imageId = parameters.find(p=>p.ParameterKey===ref)?.ResolvedValue;
    if (!imageId || !/^ami-[0-9a-f]+$/.test(imageId)) throw new Error('The deployed host AMI must be resolved before preparing activation');
    resource.Properties.LaunchTemplateData.ImageId = imageId;
    pinnedHostImages.push({resource:id,imageId});
  }
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
    resource.Properties.AvailabilityZoneRebalancing = 'DISABLED';
    resource.Properties.DeploymentConfiguration.MinimumHealthyPercent = 0;
    resource.Properties.DeploymentConfiguration.MaximumPercent = 100;
    services.add(id);
  }
  if (services.size !== profiles.length) throw new Error('Expected exactly six keeper services');
  return { template, resources:[...tasks.keys(),...services], profiles:[...tasks.values()].map(t=>t.profile), pinnedHostImages };
}

/** Refuse a prepared change set if AWS expands its scope beyond the keeper fleet. */
export function validateKeeperChangeSet(expected: string[], changeSet: any) {
  if (changeSet.Status !== 'CREATE_COMPLETE' || changeSet.ExecutionStatus !== 'AVAILABLE')
    throw new Error('Keeper change set is not available for review');
  const changes = (changeSet.Changes ?? []).map((c:any)=>c.ResourceChange);
  if (changes.length !== expected.length || new Set(changes.map((c:any)=>c.LogicalResourceId)).size !== expected.length ||
      changes.some((c:any)=>!expected.includes(c.LogicalResourceId) || c.Action !== 'Modify' ||
        !['AWS::ECS::Service','AWS::ECS::TaskDefinition'].includes(c.ResourceType)))
    throw new Error('Unexpected AWS resource changes; do not execute this change set');
}
