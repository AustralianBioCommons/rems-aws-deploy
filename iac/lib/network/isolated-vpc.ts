import { Construct } from "constructs";
import { DockerImageAsset } from "aws-cdk-lib/aws-ecr-assets";
import { HostedZone } from "aws-cdk-lib/aws-route53";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import { SslPolicy } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import {
  GatewayVpcEndpointAwsService,
  InterfaceVpcEndpointAwsService,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import { ApplicationLoadBalancedFargateService } from "aws-cdk-lib/aws-ecs-patterns";
import { Cluster, ContainerImage } from "aws-cdk-lib/aws-ecs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";

type Props = {
  awsPrivateLinksServices: InterfaceVpcEndpointAwsService[];
};

/**
 * Construct a VPC with a public subnets and isolated subnets but with
 * no NAT. Creates endpoints and gateways so that services in isolated
 * can make some AWS calls.
 */
export class PublicAndIsolatedVpc extends Vpc {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, {
      maxAzs: 99,
      natGateways: 0,
      enableDnsHostnames: true,
      enableDnsSupport: true,
      // I can't think of any reason to *not* do this - these gateways are free
      gatewayEndpoints: {
        S3: {
          service: GatewayVpcEndpointAwsService.S3,
        },
        Dynamo: {
          service: GatewayVpcEndpointAwsService.DYNAMODB,
        },
      },
    });

    let i = 0;
    for (const pl of props.awsPrivateLinksServices) {
      this.addInterfaceEndpoint(`Endpoint${i++}`, {
        service: pl,
        privateDnsEnabled: true,
        subnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      });
    }
  }
}
