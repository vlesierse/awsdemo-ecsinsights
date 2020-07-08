import { Construct, Stack, Duration } from "@aws-cdk/core";
import { Vpc, SecurityGroup, Connections, Port } from "@aws-cdk/aws-ec2";
import { Cluster, ContainerImage, Protocol, FargateService, TaskDefinition, Compatibility } from "@aws-cdk/aws-ecs";
import { DockerImageAsset } from "@aws-cdk/aws-ecr-assets";
import { ApplicationLoadBalancedFargateService } from "@aws-cdk/aws-ecs-patterns";
import { CfnCacheCluster, CfnSubnetGroup } from "@aws-cdk/aws-elasticache";
import { PrivateHostedZone } from "@aws-cdk/aws-route53";

import * as path from 'path';
import { ManagedPolicy } from "@aws-cdk/aws-iam";

export class ApplicationStack extends Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const vpc = new Vpc(this, "VPC");
    const cluster = new Cluster(this, 'Cluster', {
      vpc: vpc,
      containerInsights: true
    });
    const zone = new PrivateHostedZone(this, 'HostedZone', {
      zoneName: 'anycompany.local',
      vpc
    });

    // ElastiCache
    // The security group that defines network level access to the cluster
    const cacheSecurityGroup = new SecurityGroup(this, `CacheSecurityGroup`, { vpc });
    const cacheConnection = new Connections({
      securityGroups: [cacheSecurityGroup],
      defaultPort: Port.tcp(6379)
    });
    const cacheSubnetGroup = new CfnSubnetGroup(this, `CacheSubnetGroup`, {
      cacheSubnetGroupName: `${id}-subnet-group`,
      description: `List of subnets used for redis cache ${id}`,
      subnetIds: vpc.privateSubnets.map(subnet => subnet.subnetId)
    });
    const cacheCluster = new CfnCacheCluster(this, "RedisCache", {
      cacheNodeType: 'cache.t2.micro',
      engine: 'redis',
      numCacheNodes: 1,
      autoMinorVersionUpgrade: true,
      cacheSubnetGroupName: cacheSubnetGroup.cacheSubnetGroupName,
      vpcSecurityGroupIds: [ cacheSecurityGroup.securityGroupId ]
    });
    cacheCluster.node.addDependency(cacheSubnetGroup);

    // Image Service
    const imageServiceImage = new DockerImageAsset(this, 'ImageServiceImage', {
      directory: path.join(__dirname, '../src/imageservice')
    });
    const imageService = new ApplicationLoadBalancedFargateService(this, 'ImageService', {
      serviceName: 'imageservice',
      cluster,
      memoryLimitMiB: 1024,
      cpu: 512,
      taskImageOptions: {
        image: ContainerImage.fromDockerImageAsset(imageServiceImage),
        containerPort: 9000,
      },
      desiredCount: 1,
      assignPublicIp: false,
      domainZone: zone,
      domainName: 'image',
    });
    imageService.service.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 10,
    }).scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 40,
    });
    imageService.taskDefinition.addContainer("xray-daemon", {
      image: ContainerImage.fromRegistry("amazon/aws-xray-daemon")
    })
    .addPortMappings({
      containerPort: 2000,
      protocol: Protocol.UDP
    });
    imageService.taskDefinition.taskRole.addManagedPolicy(
			ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess')
    );
    imageService.targetGroup.configureHealthCheck({ path: "/healthz", unhealthyThresholdCount: 3, timeout: Duration.seconds(10) });

    // Catalog Service
    const catalogServiceImage = new DockerImageAsset(this, 'CatalogServiceImage', {
      directory: path.join(__dirname, '../src/catalogservice')
    });
    const catalogService = new ApplicationLoadBalancedFargateService(this, 'CatalogService', {
      serviceName: 'catalogservice',
      cluster,
      memoryLimitMiB: 1024,
      cpu: 512,
      taskImageOptions: {
        image: ContainerImage.fromDockerImageAsset(catalogServiceImage),
        containerPort: 8080,
      },
      desiredCount: 1,
      assignPublicIp: false,
      domainZone: zone,
      domainName: 'catalog'
    });
    catalogService.taskDefinition.addContainer("xray-daemon", {
      image: ContainerImage.fromRegistry("amazon/aws-xray-daemon")
    })
    .addPortMappings({
      containerPort: 2000,
      protocol: Protocol.UDP
    });
    catalogService.taskDefinition.taskRole.addManagedPolicy(
			ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess')
    );
    catalogService.targetGroup.configureHealthCheck({ path: "/api/v1/healthz" });

    // Cart Service
    const cartServiceImage = new DockerImageAsset(this, 'CartServiceImage', {
      directory: path.join(__dirname, '../src/cartservice')
    });
    const cartService = new ApplicationLoadBalancedFargateService(this, 'CartService', {
      serviceName: 'cartservice',
      cluster,
      memoryLimitMiB: 1024,
      cpu: 512,
      taskImageOptions: {
        image: ContainerImage.fromDockerImageAsset(cartServiceImage),
        containerPort: 8080,
        environment: {
          "REDIS_ENDPOINT": "redis://" + cacheCluster.attrRedisEndpointAddress + ":" + cacheCluster.attrRedisEndpointPort + "/0",
          "CATALOG_ENDPOINT": 'catalog.' + zone.zoneName,
        },
      },
      desiredCount: 1,
      assignPublicIp: false,
      domainZone: zone,
      domainName: 'cart'
    });
    cartService.taskDefinition.addContainer("xray-daemon", {
      image: ContainerImage.fromRegistry("amazon/aws-xray-daemon")
    })
    .addPortMappings({
      containerPort: 2000,
      protocol: Protocol.UDP
    });
    cartService.taskDefinition.taskRole.addManagedPolicy(
			ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess')
    );
    cartService.targetGroup.configureHealthCheck({ path: "/api/v1/healthz" });
    cartService.service.connections.allowToDefaultPort(cacheConnection);

    // Order Service
    const orderServiceImage = new DockerImageAsset(this, 'OrderServiceImage', {
      directory: path.join(__dirname, '../src/orderservice')
    });
    const orderService = new ApplicationLoadBalancedFargateService(this, 'OrderService', {
      serviceName: 'orderservice',
      cluster,
      memoryLimitMiB: 1024,
      cpu: 512,
      taskImageOptions: {
        image: ContainerImage.fromDockerImageAsset(orderServiceImage),
        containerPort: 8080,
        environment: {
          "CART_ENDPOINT": 'cart.' + zone.zoneName,
          "CATALOG_ENDPOINT": 'catalog.' + zone.zoneName,
        },
      },
      desiredCount: 1,
      assignPublicIp: false,
      domainZone: zone,
      domainName: 'order'
    });
    orderService.taskDefinition.addContainer("xray-daemon", {
      image: ContainerImage.fromRegistry("amazon/aws-xray-daemon")
    })
    .addPortMappings({
      containerPort: 2000,
      protocol: Protocol.UDP
    });
    orderService.taskDefinition.taskRole.addManagedPolicy(
			ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess')
    );
    orderService.targetGroup.configureHealthCheck({ path: "/api/v1/healthz" });

    // Recommender Service
    const recommenderServiceImage = new DockerImageAsset(this, 'RecommenderServiceImage', {
      directory: path.join(__dirname, '../src/recommenderservice')
    });
    const recommenderService = new ApplicationLoadBalancedFargateService(this, 'RecommenderService', {
      serviceName: 'recommenderservice',
      cluster,
      memoryLimitMiB: 1024,
      cpu: 512,
      taskImageOptions: {
        image: ContainerImage.fromDockerImageAsset(recommenderServiceImage),
        containerPort: 8080,
        environment: {
          "CATALOG_ENDPOINT": 'catalog.' + zone.zoneName,
        },
      },
      desiredCount: 2,
      assignPublicIp: false,
      domainZone: zone,
      domainName: 'recommender'
    });
    recommenderService.taskDefinition.addContainer("xray-daemon", {
      image: ContainerImage.fromRegistry("amazon/aws-xray-daemon")
    })
    .addPortMappings({
      containerPort: 2000,
      protocol: Protocol.UDP
    });
    recommenderService.taskDefinition.taskRole.addManagedPolicy(
			ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess')
    );
    recommenderService.targetGroup.configureHealthCheck({ path: "/api/v1/healthz" });

    
    // Frontend Service
    const frontendImage = new DockerImageAsset(this, 'FrontendImage', {
      directory: path.join(__dirname, '../src/frontend')
    });
    const frontendService = new ApplicationLoadBalancedFargateService(this, 'FrontendService', {
      serviceName: 'frontendservice',
      cluster, 
      memoryLimitMiB: 1024,
      cpu: 512,
      taskImageOptions: {
        image: ContainerImage.fromDockerImageAsset(frontendImage),
        containerPort: 8080,
        environment: {
          "REDIS_ENDPOINT": "redis://" + cacheCluster.attrRedisEndpointAddress + ":" + cacheCluster.attrRedisEndpointPort + "/0",
          "IMAGE_ENDPOINT": 'image.' + zone.zoneName,
          "CATALOG_ENDPOINT": 'catalog.' + zone.zoneName,
          "CART_ENDPOINT": 'cart.' + zone.zoneName,
          "ORDER_ENDPOINT": 'order.' + zone.zoneName,
          "RECOMMENDER_ENDPOINT": 'recommender.' + zone.zoneName,
        }
      },
      desiredCount: 1,
    });
    frontendService.taskDefinition.addContainer("xray-daemon", {
      image: ContainerImage.fromRegistry("amazon/aws-xray-daemon")
    })
    .addPortMappings({
      containerPort: 2000,
      protocol: Protocol.UDP
    });
    frontendService.taskDefinition.taskRole.addManagedPolicy(
			ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess')
    );
    frontendService.targetGroup.configureHealthCheck({ path: "/healthz", healthyHttpCodes: '200-499' });
    frontendService.service.connections.allowToDefaultPort(cacheConnection);

    const loadGeneratorImage = new DockerImageAsset(this, 'LoadGeneratorImage', {
      directory: path.join(__dirname, '../src/loadgen')
    });
    const LoadGeneratorTaskDefinition = new TaskDefinition(this, 'LoadGeneratorTaskDefinition', {
      compatibility: Compatibility.FARGATE,
      memoryMiB: '1024',
      cpu: '512',
    });
    LoadGeneratorTaskDefinition.addContainer('generator', {
      image: ContainerImage.fromDockerImageAsset(loadGeneratorImage),
      environment: {
        'FRONTEND_ADDR': frontendService.loadBalancer.loadBalancerDnsName
      }
    });
    new FargateService(this, 'LoadGenerator', {
      serviceName: 'loadgenerator',
      cluster, 
      taskDefinition: LoadGeneratorTaskDefinition,
      desiredCount: 1
    });
  }
}