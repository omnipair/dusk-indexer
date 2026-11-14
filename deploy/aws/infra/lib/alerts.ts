import { Aspects, CfnCondition, CfnOutput, CfnParameter, Fn, Stack, type IAspect, type StackProps } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as events from 'aws-cdk-lib/aws-events';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import type { Construct, IConstruct } from 'constructs';

export class AlertsStack extends Stack {
  readonly topic: sns.Topic;
  constructor(scope: Construct, id: string, props: StackProps & { readonly primary: boolean }) {
    super(scope, id, props);
    const recipients = [1, 2].map(index => new CfnParameter(this, `AlertEmail${index}`, { type: 'String', default: '', noEcho: true }));
    this.topic = new sns.Topic(this, 'OutageAlerts', { displayName: 'Dusk mainnet infrastructure alerts', enforceSSL: true });
    this.topic.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')], actions: ['sns:Publish'], resources: [this.topic.topicArn],
      conditions: { StringEquals: { 'aws:SourceAccount': this.account }, ArnLike: { 'aws:SourceArn': `arn:aws:cloudwatch:${this.region}:${this.account}:alarm:Dusk*` } },
    }));
    this.topic.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('events.amazonaws.com')], actions: ['sns:Publish'], resources: [this.topic.topicArn],
      conditions: { StringEquals: { 'aws:SourceAccount': this.account }, ArnLike: { 'aws:SourceArn': `arn:aws:events:${this.region}:${this.account}:rule/Dusk*` } },
    }));
    for (const [index, email] of recipients.entries()) {
      const configured = new CfnCondition(this, `HasEmail${index + 1}`, { expression: Fn.conditionNot(Fn.conditionEquals(email.valueAsString, '')) });
      const subscription = new sns.CfnSubscription(this, `Email${index + 1}`, { protocol: 'email', endpoint: email.valueAsString, topicArn: this.topic.topicArn });
      subscription.cfnOptions.condition = configured;
    }
    if (props.primary) {
      new budgets.CfnBudget(this, 'MonthlyBudget', {
        budget: {
          budgetName: 'DuskMainnetMonthly', budgetType: 'COST', timeUnit: 'MONTHLY',
          budgetLimit: { amount: 400, unit: 'USD' },
          costTypes: { includeCredit: false, includeRefund: false, includeTax: false, useBlended: false },
        },
        notificationsWithSubscribers: ['ACTUAL', 'FORECASTED'].map(notificationType => ({
          notification: { notificationType, comparisonOperator: 'GREATER_THAN', threshold: notificationType === 'ACTUAL' ? 80 : 100, thresholdType: 'PERCENTAGE' },
          subscribers: recipients.map(email => ({ subscriptionType: 'EMAIL', address: email.valueAsString })),
        })),
      });
    }
    new CfnOutput(this, 'OutageTopicArn', { value: this.topic.topicArn });
  }
  attachTo(stack: Stack): void {
    const topicArn = this.topic.topicArn;
    Aspects.of(stack).add(new class implements IAspect {
      visit(node: IConstruct): void {
        if (node instanceof cloudwatch.CfnAlarm) {
          node.alarmActions = [topicArn];
          node.okActions = [topicArn];
        }
      }
    }());
    const cluster = stack.node.tryFindChild('Cluster');
    if (cluster instanceof ecs.Cluster) {
      new events.CfnRule(stack, 'UnexpectedTaskExit', {
        eventPattern: {
          source: ['aws.ecs'], 'detail-type': ['ECS Task State Change'],
          detail: { clusterArn: [cluster.clusterArn], lastStatus: ['STOPPED'], stopCode: ['EssentialContainerExited', 'TaskFailedToStart'] },
        },
        targets: [{ id: 'OutageAlert', arn: topicArn, inputTransformer: {
          inputPathsMap: { service: '$.detail.group', reason: '$.detail.stoppedReason', cluster: '$.detail.clusterArn' },
          inputTemplate: '{"service":<service>,"reason":<reason>,"cluster":<cluster>}',
        } }],
      });
    }
  }
}
