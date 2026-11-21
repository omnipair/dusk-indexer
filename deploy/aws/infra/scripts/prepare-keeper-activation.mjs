import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareKeeperActivation } from '../lib/keeper-activation.ts';

const {values}=parseArgs({options:{
  profile:{type:'string',default:'dusk-admin'},
  'output-dir':{type:'string'},
  'change-set-name':{type:'string',default:'keepers-mainnet-20261121'},
  'create-change-set':{type:'boolean',default:false},
}});
if(!values['output-dir']) throw Error('--output-dir is required');
const directory=resolve(values['output-dir']);mkdirSync(directory,{recursive:true,mode:0o700});
const aws=(...args)=>{
  const r=spawnSync('aws',[...args,'--profile',values.profile,'--region','ap-southeast-1','--no-cli-pager','--output','json'],{encoding:'utf8',maxBuffer:16*1024*1024,timeout:120000});
  if(r.status!==0) throw Error(r.stderr || 'AWS request failed');
  return JSON.parse(r.stdout||'{}');
};
const save=(name,value)=>{const path=join(directory,name);writeFileSync(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});return path;};
if(aws('sts','get-caller-identity').Account!=='009853298730') throw Error('Unexpected AWS account');
const stack=aws('cloudformation','describe-stacks','--stack-name','DuskServicesSingapore').Stacks[0];
if(!['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(stack.StackStatus)) throw Error('Wait for the service stack to stabilize');
const original=aws('cloudformation','get-template','--stack-name',stack.StackName,'--template-stage','Original').TemplateBody;
const source=typeof original==='string'?JSON.parse(original):original;
save('template-before.json',source);save('stack-before.json',stack);
const plan=prepareKeeperActivation(source);
const file=save('keeper-live-template.json',plan.template);
const parameters=[...stack.Parameters.map(p=>({ParameterKey:p.ParameterKey,UsePreviousValue:true})),{ParameterKey:'KeeperMode',ParameterValue:'live'}];
const parameterFile=save('keeper-live-parameters.json',parameters);
const result={stack:stack.StackName,profiles:plan.profiles,changedResources:plan.resources,executed:false};
if(values['create-change-set']){
  const digest=createHash('sha256').update(JSON.stringify(plan.template)).digest('hex');
  const toolkit=aws('cloudformation','describe-stacks','--stack-name','CDKToolkit').Stacks[0];
  const outputs=Object.fromEntries(toolkit.Outputs.map(o=>[o.OutputKey,o.OutputValue]));
  const key=`keeper-activation/${digest}.json`;
  aws('s3api','put-object','--bucket',outputs.BucketName,'--key',key,'--body',file,'--server-side-encryption','AES256','--content-type','application/json');
  const change=aws('cloudformation','create-change-set','--stack-name',stack.StackName,'--change-set-name',values['change-set-name'],
    '--change-set-type','UPDATE','--template-url',`https://${outputs.BucketDomainName}/${key}`,
    '--parameters',`file://${parameterFile}`,'--capabilities','CAPABILITY_IAM',
    '--description','OPERATOR ONLY: six keeper profiles, existing wallets and image, reviewed token settings. Prepared, not executed.');
  result.changeSetArn=change.Id;
  result.templateSha256=digest;
}
save('activation-plan.json',result);
console.log(JSON.stringify(result,null,2));
// Deliberately no ExecuteChangeSet, UpdateService, RunTask or transaction API.
