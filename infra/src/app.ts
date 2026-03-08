#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib'
import { resolveConfig } from './config.js'
import { NetworkStack } from './network-stack.js'
import { StratosServiceStack } from './stratos-service-stack.js'
import { WebappStack } from './webapp-stack.js'

const config = await resolveConfig()

const app = new cdk.App()

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
}

const network = new NetworkStack(app, `Stratos-Network-${config.environment}`, {
  env,
  config,
  description: 'Stratos VPC, ECS cluster, Route53 zone, and ECR repositories',
})

const imageTag = app.node.tryGetContext('imageTag') ?? 'latest'
const stratosImageDigest = app.node.tryGetContext('stratosImageDigest') ?? ''
const webappImageDigest = app.node.tryGetContext('webappImageDigest') ?? ''

const stratosService = new StratosServiceStack(app, `Stratos-Service-${config.environment}`, {
  env,
  config,
  vpc: network.vpc,
  cluster: network.cluster,
  hostedZone: network.hostedZone,
  repository: network.stratosRepo,
  imageTag,
  imageDigest: stratosImageDigest,
  description: 'Stratos API on ECS Fargate with ALB and ACM SSL',
})
stratosService.addDependency(network)

const webapp = new WebappStack(app, `Stratos-Webapp-${config.environment}`, {
  env,
  config,
  vpc: network.vpc,
  cluster: network.cluster,
  hostedZone: network.hostedZone,
  repository: network.webappRepo,
  imageTag,
  imageDigest: webappImageDigest,
  description: 'Stratos webapp on ECS Fargate with ALB and ACM SSL',
})
webapp.addDependency(network)

app.synth()
