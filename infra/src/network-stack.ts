import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as route53 from 'aws-cdk-lib/aws-route53'
import type { Construct } from 'constructs'
import type { StratosConfig } from './config.js'

export interface NetworkStackProps extends cdk.StackProps {
  config: StratosConfig
}

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc
  public readonly cluster: ecs.ICluster
  public readonly hostedZone: route53.IHostedZone
  public readonly stratosRepo: ecr.IRepository
  public readonly webappRepo: ecr.IRepository

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props)
    const { config } = props

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    })

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: this.vpc,
      clusterName: `stratos-${config.environment}`,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    })

    if (config.hostedZoneId) {
      this.hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: config.hostedZoneId,
        zoneName: config.domainName,
      })
    } else {
      this.hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
        domainName: config.domainName,
      })
    }

    // ECR repositories
    this.stratosRepo = new ecr.Repository(this, 'StratosRepo', {
      repositoryName: `stratos-${config.environment}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 10, description: 'Keep last 10 images' }],
    })

    this.webappRepo = new ecr.Repository(this, 'WebappRepo', {
      repositoryName: `stratos-webapp-${config.environment}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 10, description: 'Keep last 10 images' }],
    })
  }
}
