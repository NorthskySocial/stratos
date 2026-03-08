import * as cdk from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as efs from 'aws-cdk-lib/aws-efs'
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets'
import type { Construct } from 'constructs'
import type { StratosConfig } from './config.js'

export interface StratosServiceStackProps extends cdk.StackProps {
  config: StratosConfig
  vpc: ec2.IVpc
  cluster: ecs.ICluster
  hostedZone: route53.IHostedZone
  repository: ecr.IRepository
  imageTag: string
  imageDigest: string
}

export class StratosServiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StratosServiceStackProps) {
    super(scope, id, props)
    const { config, vpc, cluster, hostedZone, repository, imageTag, imageDigest } = props

    const fqdn = `${config.stratosSubdomain}.${config.domainName}`

    // ACM certificate with DNS validation
    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: fqdn,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    })

    // EFS for persistent Stratos data (SQLite databases, blobs)
    const fileSystem = new efs.FileSystem(this, 'DataVolume', {
      vpc,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encrypted: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
    })

    const accessPoint = fileSystem.addAccessPoint('DataAccessPoint', {
      path: '/stratos-data',
      createAcl: { ownerGid: '1000', ownerUid: '1000', permissions: '755' },
      posixUser: { gid: '1000', uid: '1000' },
    })

    // Task definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: config.stratosTaskCpu ?? 512,
      memoryLimitMiB: config.stratosTaskMemory ?? 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    })

    taskDefinition.addVolume({
      name: 'stratos-data',
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: { accessPointId: accessPoint.accessPointId, iam: 'ENABLED' },
      },
    })

    const stratosEnv: Record<string, string> = {
      STRATOS_SERVICE_DID: config.stratos.serviceDid,
      STRATOS_PUBLIC_URL: config.stratos.publicUrl,
      STRATOS_PORT: '3100',
      STRATOS_DATA_DIR: '/app/data',
      STRATOS_ALLOWED_DOMAINS: config.stratos.allowedDomains,
      NODE_ENV: 'production',
    }

    // Add optional env vars
    const optionalVars: Record<string, string | undefined> = {
      STRATOS_SERVICE_FRAGMENT: config.stratos.serviceFragment,
      STRATOS_RETENTION_DAYS: config.stratos.retentionDays,
      STRATOS_ENROLLMENT_MODE: config.stratos.enrollmentMode,
      STRATOS_ALLOWED_DIDS: config.stratos.allowedDids,
      STRATOS_ALLOWED_PDS_ENDPOINTS: config.stratos.allowedPdsEndpoints,
      STRATOS_PLC_URL: config.stratos.plcUrl,
      STRATOS_SIGNING_KEY_HEX: config.stratos.signingKeyHex,
      STRATOS_OAUTH_CLIENT_ID: config.stratos.oauthClientId,
      STRATOS_OAUTH_CLIENT_SECRET: config.stratos.oauthClientSecret,
      STRATOS_OAUTH_CLIENT_NAME: config.stratos.oauthClientName,
      STRATOS_OAUTH_LOGO_URI: config.stratos.oauthLogoUri,
      STRATOS_OAUTH_TOS_URI: config.stratos.oauthTosUri,
      STRATOS_OAUTH_POLICY_URI: config.stratos.oauthPolicyUri,
      STRATOS_REPO_URL: config.stratos.repoUrl,
      STRATOS_OPERATOR_CONTACT: config.stratos.operatorContact,
      LOG_LEVEL: config.stratos.logLevel,
      STRATOS_DEV_MODE: config.stratos.devMode,
      STRATOS_BLOB_STORAGE: config.stratos.blobStorage,
    }

    for (const [key, value] of Object.entries(optionalVars)) {
      if (value) stratosEnv[key] = value
    }

    const container = taskDefinition.addContainer('stratos', {
      image: ecs.ContainerImage.fromEcrRepository(repository, imageTag),
      environment: stratosEnv,
      dockerLabels: imageDigest ? { 'com.stratos.image-digest': imageDigest } : undefined,
      portMappings: [{ containerPort: 3100, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'stratos',
        logGroup: new logs.LogGroup(this, 'LogGroup', {
          logGroupName: `/ecs/stratos-${config.environment}`,
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
      healthCheck: {
        command: ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', 'http://localhost:3100/health'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    })

    container.addMountPoints({
      sourceVolume: 'stratos-data',
      containerPath: '/app/data',
      readOnly: false,
    })

    // Security group for the service
    const serviceSg = new ec2.SecurityGroup(this, 'ServiceSg', {
      vpc,
      description: 'Stratos Fargate service',
      allowAllOutbound: true,
    })

    fileSystem.connections.allowDefaultPortFrom(serviceSg, 'Allow EFS from Stratos tasks')

    // Fargate service
    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      desiredCount: config.stratosDesiredCount ?? 1,
      securityGroups: [serviceSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
      circuitBreaker: { enable: true, rollback: true },
    })

    // Allow task role to use EFS
    fileSystem.grantReadWrite(taskDefinition.taskRole)

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

    httpsListener.addTargets('StratosTarget', {
      port: 3100,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
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

    // Route53 alias record
    new route53.ARecord(this, 'DnsRecord', {
      zone: hostedZone,
      recordName: config.stratosSubdomain,
      target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(alb)),
    })

    // Outputs
    new cdk.CfnOutput(this, 'StratosUrl', { value: `https://${fqdn}` })
    new cdk.CfnOutput(this, 'AlbDns', { value: alb.loadBalancerDnsName })
  }
}
