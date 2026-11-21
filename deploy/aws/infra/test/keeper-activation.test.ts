import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareKeeperActivation } from '../lib/keeper-activation.js';

function fixture() {
  const Resources:Record<string,any>={Api:{Type:'AWS::ECS::TaskDefinition',Properties:{ContainerDefinitions:[{Name:'api',Image:'unchanged',Secrets:[{Name:'DATABASE_URL',ValueFrom:'secret:api'}]}]}}};
  for(const profile of ['lending','leverage','hlp-recovery','auction-arbitrage','lifecycle','sentinel']){
    const env:Record<string,string>={KEEPER_PROFILE:profile,KEEPER_MODE:'shadow',DUSK_CLUSTER:'mainnet-beta'};
    if(profile!=='sentinel')Object.assign(env,{SIGNER_PROVIDER:'aws-kms',SIGNER_KEY_ID:'key:'+profile,KEEPER_SIGNER_PUBLIC_KEY:'wallet:'+profile});
    if(profile==='hlp-recovery')env.KEEPER_HLP_MARKET='GWrmPqBcmBgX3fcE3GPA6xgCUP3Cbd4DRvXHyfwu1795';
    Resources[profile+'Task']={Type:'AWS::ECS::TaskDefinition',Properties:{TaskRoleArn:'role:'+profile,ContainerDefinitions:[{Name:profile,Image:'unchanged',Secrets:[{Name:'RPC',ValueFrom:'secret:'+profile}],Environment:Object.entries(env).map(([Name,Value])=>({Name,Value}))}]}};
    Resources[profile+'Service']={Type:'AWS::ECS::Service',Properties:{DesiredCount:1,TaskDefinition:{Ref:profile+'Task'},DeploymentConfiguration:{MinimumHealthyPercent:100,MaximumPercent:200,DeploymentCircuitBreaker:{Enable:true,Rollback:true}}}};
  }
  return {Parameters:{Image:{Type:'String'}},Resources};
}

test('activation plan preserves other apps, image pins, roles, secrets and wallet identities',()=>{
  const source=fixture();const unchanged=structuredClone(source);
  const {template,resources}=prepareKeeperActivation(source);
  assert.deepEqual(source,unchanged);
  assert.deepEqual(template.Resources.Api,source.Resources.Api);
  assert.equal(resources.length,12);
  assert.equal(template.Parameters?.KeeperMode.Default,'shadow');
  for(const [id,r] of Object.entries(source.Resources)){
    if(r.Type!=='AWS::ECS::TaskDefinition'||id==='Api')continue;
    const next=template.Resources[id].Properties;
    assert.equal(next.TaskRoleArn,r.Properties.TaskRoleArn);
    assert.equal(next.ContainerDefinitions[0].Image,r.Properties.ContainerDefinitions[0].Image);
    assert.deepEqual(next.ContainerDefinitions[0].Secrets,r.Properties.ContainerDefinitions[0].Secrets);
    for(const e of r.Properties.ContainerDefinitions[0].Environment.filter((e:any)=>e.Name!=='KEEPER_MODE'))
      assert.deepEqual(next.ContainerDefinitions[0].Environment.find((n:any)=>n.Name===e.Name),e);
  }
});

test('activation plan refuses partial fleets, unknown modes, missing identities and missing hLP market',()=>{
  for(const mutate of [
    (t:any)=>delete t.Resources.lendingTask,
    (t:any)=>t.Resources.lendingTask.Properties.ContainerDefinitions[0].Environment.find((e:any)=>e.Name==='KEEPER_MODE').Value='live',
    (t:any)=>t.Resources.lendingTask.Properties.ContainerDefinitions[0].Environment.splice(3,1),
    (t:any)=>t.Resources['hlp-recoveryTask'].Properties.ContainerDefinitions[0].Environment.pop(),
  ]){const t=fixture();mutate(t);assert.throws(()=>prepareKeeperActivation(t));}
});
