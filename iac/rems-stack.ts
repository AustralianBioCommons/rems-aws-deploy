import {CfnOutput, Duration, RemovalPolicy, Stack, StackProps,} from "aws-cdk-lib";
import {Construct} from "constructs";
import {
  InstanceClass,
  InstanceSize,
  InstanceType,
  IVpc,
  Port,
  SecurityGroup,
  SubnetSelection,
  SubnetType,
} from "aws-cdk-lib/aws-ec2";
import {
  Credentials,
  DatabaseCluster,
  DatabaseInstance,
  DatabaseInstanceEngine,
  PostgresEngineVersion,
} from "aws-cdk-lib/aws-rds";
import {DockerImageCode, DockerImageFunction} from "aws-cdk-lib/aws-lambda";
import {DockerImageAsset} from "aws-cdk-lib/aws-ecr-assets";
import * as path from "path";
import {DockerServiceWithHttpsLoadBalancerConstruct} from "./lib/docker-service-with-https-load-balancer-construct";
import {PublicAndNatVpc} from "./lib/network/nat-vpc";
import {HttpNamespace, Service} from "aws-cdk-lib/aws-servicediscovery";
import {Cluster, TaskDefinition} from "aws-cdk-lib/aws-ecs";
import {Policy, PolicyStatement} from "aws-cdk-lib/aws-iam";
import {LogGroup} from "aws-cdk-lib/aws-logs";
import {ISecret} from "aws-cdk-lib/aws-secretsmanager";

// these are settings for the database *within* the RDS instance, and the postgres user name
// they really shouldn't need to be changed but I will define them here as constants in case
const FIXED_DATABASE_NAME = "rems";
const FIXED_DATABASE_USER = "rems";
const FIXED_CONTAINER_NAME = "rems";
const FIXED_SERVICE_NAME = "rems";

export class RemsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const cloudMapNamespace = this.node.tryGetContext("cloudMapNamespace");
    const cloudMapId = this.node.tryGetContext("cloudMapId");
    const hostedPrefix = this.node.tryGetContext("hostedPrefix");
    const hostedZoneName = this.node.tryGetContext("hostedZoneName");
    const hostedZoneCert = this.node.tryGetContext("hostedZoneCert");
    const oidcMetadataUrl = this.node.tryGetContext("oidcMetadataUrl");
    const oidcClientId = this.node.tryGetContext("oidcClientId");
    const oidcClientSecret = this.node.tryGetContext("oidcClientSecret");
    const smtpHost = this.node.tryGetContext("smtpHost");
    const smtpMailFrom = this.node.tryGetContext("smtpMailFrom");
    const smtpUser = this.node.tryGetContext("smtpUser");
    const smtpPassword = this.node.tryGetContext("smtpPassword");

    if (
      !cloudMapNamespace ||
      !cloudMapId ||
      !hostedPrefix ||
      !hostedZoneName ||
      !hostedZoneCert ||
      !oidcMetadataUrl ||
      !oidcClientId ||
      !oidcClientSecret ||
      !smtpHost ||
      !smtpMailFrom ||
      !smtpUser ||
      !smtpPassword
    )
      throw new Error(
        "Context values must be passed into CDK invocation to set some important mandatory deployment settings"
      );

    const vpc = new PublicAndNatVpc(this, "Vpc", {});
    const subnetSelection: SubnetSelection = {
      subnetType: SubnetType.PRIVATE_WITH_NAT,
    };

    // because REMS does not use any native AWS features (makes no AWS calls) we would love it to be
    // self-contained (no ingress/egress except to itself).
    // However, the AWS container infrastructure does need to make log API calls to AWS.
    // So we set this security group with outbound traffic on - but with ingress only from itself.
    const dbAndClusterSecurityGroup = new SecurityGroup(
      this,
      "DbAndClusterSecurityGroup",
      {
        vpc,
        allowAllOutbound: true,
      }
    );

    dbAndClusterSecurityGroup.addIngressRule(
      dbAndClusterSecurityGroup,
      Port.allTraffic()
    );

    // create the db instance or cluster
    const [db, remsDatabaseUrl] = this.addDatabase(
      vpc,
      subnetSelection,
      dbAndClusterSecurityGroup
    );

    const dockerImageFolder = path.join(__dirname, "rems-docker-image");

    const asset = new DockerImageAsset(this, "RemsDockerImage", {
      directory: dockerImageFolder,

      buildArgs: {},
    });

    const privateServiceWithLoadBalancer =
      new DockerServiceWithHttpsLoadBalancerConstruct(
        this,
        "PrivateServiceWithLb",
        {
          vpc: vpc,
          securityGroups: [dbAndClusterSecurityGroup],
          hostedPrefix: hostedPrefix,
          hostedZoneName: hostedZoneName,
          hostedZoneCertArn: hostedZoneCert,
          imageAsset: asset,
          memoryLimitMiB: 2048,
          cpu: 1024,
          // confirmed with REMS team - concurrent instances not supported due to the way job queues are scheduled
          // internal to REMS. So even though this is behind a high availability load balancer - only 1 instance
          // is supported
          desiredCount: 1,
          containerName: FIXED_CONTAINER_NAME,
          healthCheckPath: "/",
          environment: {
            // rather than embed these in the config.edn that is checked into git -
            // we use the mechanism by which these settings can be made using environment variables
            // and then allow these values to be fetched from parameterstore/secrets etc
            // the *key* names here must match the config setting names from the EDN
            DATABASE_URL: remsDatabaseUrl,
            OIDC_METADATA_URL: oidcMetadataUrl,
            OIDC_CLIENT_ID: oidcClientId,
            OIDC_CLIENT_SECRET: oidcClientSecret,
            PUBLIC_URL: `https://${hostedPrefix}.${hostedZoneName}/`,
            SMTP__HOST: smtpHost,
            SMTP__PORT: "587",
            SMTP__USER: smtpUser,
            SMTP__PASS: smtpPassword,
            MAIL_FROM: smtpMailFrom,
            SMTP_DEBUG: "true",
          },
        }
      );

    // the command function is an invocable lambda that will then go and spin up an ad-hoc Task in our
    // cluster - we use this for starting admin tasks
    const commandFunction = this.addCommandLambda(
      vpc,
      subnetSelection,
      privateServiceWithLoadBalancer.cluster,
      privateServiceWithLoadBalancer.clusterLogGroup,
      privateServiceWithLoadBalancer.service.taskDefinition,
      [dbAndClusterSecurityGroup]
    );

    // we want to register our lambda into a namespace - so that our CLI tool can locate the
    // lambda for admin tasks
    const namespace = HttpNamespace.fromHttpNamespaceAttributes(
      this,
      "Namespace",
      {
        // this is a bug in the CDK definitions - this field is optional but not defined that way
        // passing an empty string does work
        namespaceArn: "",
        // this is also a bug? surely we should be able to look up a namespace just by name
        namespaceId: cloudMapId,
        namespaceName: cloudMapNamespace,
      }
    );

    const service = new Service(this, "Service", {
      namespace: namespace,
      name: FIXED_SERVICE_NAME,
      description: "Service for working with REMS",
    });

    service.registerNonIpInstance("CommandLambda", {
      customAttributes: {
        lambdaArn: commandFunction.functionArn,
      },
    });

    new CfnOutput(this, "RemsDatabaseUrl", {
      value: remsDatabaseUrl,
    });
    new CfnOutput(this, "ClusterArn", {
      value: privateServiceWithLoadBalancer.cluster.clusterArn,
    });
    new CfnOutput(this, "TaskDefinitionArn", {
      value:
        privateServiceWithLoadBalancer.service.taskDefinition.taskDefinitionArn,
    });
  }

  /**
   * Creates either a single database instance. Returns the relevant instance, as well as a URL suitable for connecting
   * to the instance.
   *
   * @param vpc the VPC to put the db in
   * @param subnetSelection the subnet in the VPC to put the db in
   * @param securityGroup the security group to assign to the db
   * @private
   */
  private addDatabase(
    vpc: IVpc,
    subnetSelection: SubnetSelection,
    securityGroup: SecurityGroup
  ): [DatabaseCluster | DatabaseInstance, string] {
    // we actually had an issue where the default password it picked for postgres was invalid
    //    rems/rems/1a7993ef1d2345b78b2066efbe193cde Exception in thread
    //       "main" java.net.URISyntaxException: Illegal character in query at index 109:
    // in a JDBC connection url (the "^" I think).. so anyhow I've made the exclusions to be the default
    // set plus a bunch of others
    const dbCreds = Credentials.fromUsername(FIXED_DATABASE_USER, {
      excludeCharacters: " %+~`#$&*()|[]{}:;<>?!'/@\"\\" + "^_-=",
    });

    let db: DatabaseInstance;
    let dbSocketAddress: string;
    let dbSecret: ISecret;

    db = new DatabaseInstance(this, "Database", {
      removalPolicy: RemovalPolicy.DESTROY,
      engine: DatabaseInstanceEngine.postgres({
        version: PostgresEngineVersion.VER_14,
      }),
      credentials: dbCreds,
      databaseName: FIXED_DATABASE_NAME,
      instanceType: InstanceType.of(
        InstanceClass.BURSTABLE4_GRAVITON,
        InstanceSize.SMALL
      ),
      vpc: vpc,
      vpcSubnets: subnetSelection,
      securityGroups: [securityGroup],
    });
    dbSocketAddress = (db as DatabaseInstance).instanceEndpoint.socketAddress;
    dbSecret = (db as DatabaseInstance).secret!;

    // the REMS user and db will have been already created as part of the DB instance/cluster construction
    const remsDatabaseUrl = `postgresql://${dbSocketAddress}/rems?user=${FIXED_DATABASE_USER}&password=${dbSecret.secretValueFromJson(
      "password"
    )}`;

    return [db, remsDatabaseUrl];
  }

  /**
   * Add a command lambda that can start REMS tasks in the cluster for the purposes of
   * executing REMS docker commands.
   *
   * @param vpc
   * @param subnetSelection
   * @param cluster
   * @param clusterLogGroup
   * @param taskDefinition
   * @param taskSecurityGroups
   * @private
   */
  private addCommandLambda(
    vpc: IVpc,
    subnetSelection: SubnetSelection,
    cluster: Cluster,
    clusterLogGroup: LogGroup,
    taskDefinition: TaskDefinition,
    taskSecurityGroups: SecurityGroup[]
  ): DockerImageFunction {
    const commandLambdaSecurityGroup = new SecurityGroup(
      this,
      "CommandLambdaSecurityGroup",
      {
        vpc: vpc,
        // this needs outbound to be able to make the AWS calls it needs (don't want to add PrivateLink)
        allowAllOutbound: true,
      }
    );

    const dockerImageFolder = path.join(
      __dirname,
      "rems-command-invoke-lambda-docker-image"
    );

    const f = new DockerImageFunction(this, "CommandLambda", {
      memorySize: 128,
      code: DockerImageCode.fromImageAsset(dockerImageFolder),
      vpcSubnets: subnetSelection,
      vpc: vpc,
      securityGroups: [commandLambdaSecurityGroup],
      timeout: Duration.minutes(14),
      environment: {
        CLUSTER_ARN: cluster.clusterArn,
        CLUSTER_LOG_GROUP_NAME: clusterLogGroup.logGroupName,
        TASK_DEFINITION_ARN: taskDefinition.taskDefinitionArn,
        CONTAINER_NAME: FIXED_CONTAINER_NAME,
        // we are passing to the lambda the subnets and security groups that need to be used
        // by the Fargate task it will invoke
        SUBNETS: vpc
          .selectSubnets(subnetSelection)
          .subnets.map((s) => s.subnetId)
          .join(",")!,
        SECURITY_GROUPS: taskSecurityGroups
          .map((sg) => sg.securityGroupId)
          .join(",")!,
      },
    });

    f.role?.attachInlinePolicy(
      new Policy(this, "CommandTasksPolicy", {
        statements: [
          // restricted to running our task only on our cluster
          new PolicyStatement({
            actions: ["ecs:RunTask"],
            resources: [taskDefinition.taskDefinitionArn],
            conditions: {
              ArnEquals: {
                "ecs:Cluster": cluster.clusterArn,
              },
            },
          }),
          // restricted to describing tasks only on our cluster
          new PolicyStatement({
            actions: ["ecs:DescribeTasks"],
            resources: ["*"],
            conditions: {
              ArnEquals: {
                "ecs:Cluster": cluster.clusterArn,
              },
            },
          }),
          // give the ability to invoke the task
          new PolicyStatement({
            actions: ["iam:PassRole"],
            resources: [
              taskDefinition.executionRole?.roleArn!,
              taskDefinition.taskRole.roleArn!,
            ],
          }),
        ],
      })
    );

    return f;
  }
}
