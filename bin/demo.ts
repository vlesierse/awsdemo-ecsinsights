import * as cdk from '@aws-cdk/core';
import { PipelineStack } from '../lib/pipeline-stack';
import { ApplicationStack } from '../lib/application-stack';

const app = new cdk.App();
cdk.Tag.add(app, 'project', 'Demo: ECS Insights');
new PipelineStack(app, 'ECSInsightsPipeline');
new ApplicationStack(app, 'ECSInsightsApplication');