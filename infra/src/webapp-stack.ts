import * as cdk from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets'
import type { Construct } from 'constructs'
import type { StratosConfig } from './config.js'

export interface WebappStackProps extends cdk.StackProps {
  config: StratosConfig
  vpc: ec2.IVpc
  cluster: ecs.ICluster
  hostedZone: route53.IHostedZone
  repository: ecr.IRepository
  imageTag: string
  imageDigest: string
}

export class WebappStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebappStackProps) {
    super(scope, id, props)
    const { config, vpc, cluster, hostedZone, repository, imageTag, imageDigest } = props

    const fqdn = `${config.webappSubdomain}.${config.domainName}`

    // ACM certificate
    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: fqdn,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    })

    // Task definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: config.webappTaskCpu ?? 256,
      memoryLimitMiB: config.webappTaskMemory ?? 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    })

    taskDefinition.addContainer('webapp', {
      image: ecs.ContainerImage.fromEcrRepository(repository, imageTag),
      dockerLabels: imageDigest ? { 'com.stratos.image-digest': imageDigest } : undefined,
      portMappings: [{ containerPort: 80, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'webapp',
        logGroup: new logs.LogGroup(this, 'LogGroup', {
          logGroupName: `/ecs/stratos-webapp-${config.environment}`,
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
      healthCheck: {
        command: ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', 'http://localhost:80/'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(10),
      },
    })

    // Fargate service
    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      desiredCount: config.webappDesiredCount ?? 1,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      circuitBreaker: { enable: true, rollback: true },
    })

    // ALB
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
    })

    // HTTPS listener
    const httpsListener = alb.addListener('HttpsListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
      sslPolicy: elbv2.SslPolicy.TLS13_RES,
    })

    httpsListener.addTargets('WebappTarget', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: '/',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: cdk.Duration.seconds(15),
    })

    // HTTP → HTTPS redirect
    alb.addListener('HttpRedirect', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    })

    // Route53 alias
    new route53.ARecord(this, 'DnsRecord', {
      zone: hostedZone,
      recordName: config.webappSubdomain,
      target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(alb)),
    })

    // Outputs
    new cdk.CfnOutput(this, 'WebappUrl', { value: `https://${fqdn}` })
    new cdk.CfnOutput(this, 'AlbDns', { value: alb.loadBalancerDnsName })
  }
}
