/* Copyright OpenSearch Contributors
SPDX-License-Identifier: Apache-2.0

The OpenSearch Contributors require contributions made to
this file be licensed under the Apache-2.0 license or a
compatible open source license. */

import { Stack, StackProps } from 'aws-cdk-lib';
import { EbsDeviceVolumeType } from 'aws-cdk-lib/aws-autoscaling';
import {
  AmazonLinuxCpuType,
  ISecurityGroup,
  IVpc,
  InstanceType,
  SecurityGroup,
} from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { dump } from 'js-yaml';
import { InfraStack } from './infra/infra-stack';
import { NetworkStack } from './networking/vpc-stack';
import {
  arm64Ec2InstanceType,
  getArm64InstanceTypes,
  getVolumeType,
  getX64InstanceTypes,
  x64Ec2InstanceType,
} from './opensearch-config/node-config';

enum cpuArchEnum{
    X64='x64',
    ARM64='arm64'
}

const getInstanceType = (instanceType: string, arch: string) => {
  if (arch === 'x64') {
    if (instanceType !== 'undefined') {
      return getX64InstanceTypes(instanceType);
    }
    return getX64InstanceTypes('r5.xlarge');
  }
  if (instanceType !== 'undefined') {
    return getArm64InstanceTypes(instanceType);
  }
  return getArm64InstanceTypes('r6g.xlarge');
};
export interface OsClusterEntrypointProps extends StackProps {
  readonly suffix ?: string;
  readonly networkStackSuffix ?: string;
  readonly distVersion?: string;
  readonly securityDisabled?: boolean;
  readonly minDistribution?: boolean;
  readonly distributionUrl?: string;
  readonly cpuArch?: string;
  readonly singleNodeCluster?: boolean;
  readonly serverAccessType?: string;
  readonly restrictServerAccessTo ?: string;
  readonly dashboardsUrl?: string;
  readonly vpcID?: IVpc;
  readonly securityGroup?: ISecurityGroup;
  readonly cidr ?: string;
  readonly managerNodeCount?: number;
  readonly dataNodeCount?: number;
  readonly ingestNodeCount?: number;
  readonly clientNodeCount?: number;
  readonly mlNodeCount?: number;
  readonly dataNodeStorage?: number;
  readonly mlNodeStorage?: number;
  readonly dataInstanceType?: InstanceType;
  readonly mlInstanceType?: InstanceType;
  readonly use50PercentHeap?: boolean;
  readonly isInternal?: boolean;
  readonly enableRemoteStore?: boolean;
  readonly storageVolumeType?: EbsDeviceVolumeType;
  readonly customRoleArn?: string;
  readonly jvmSysProps?: string;
  readonly additionalConfig?: string;
  readonly additionalOsdConfig?: string;
  readonly customConfigFiles?: string;
  readonly enableMonitoring?: boolean;
}

export class OsClusterEntrypoint {
    public stacks: Stack[] = [];

    public vpc: IVpc;

    public securityGroup = SecurityGroup;

    constructor(scope: Construct, props: OsClusterEntrypointProps) {
      let instanceCpuType: AmazonLinuxCpuType;
      let managerCount: number;
      let dataCount: number;
      let clientCount: number;
      let ingestCount: number;
      let mlCount: number;
      let infraStackName: string;
      let dataNodeStorage: number;
      let mlNodeStorage: number;
      let ymlConfig: string = 'undefined';
      let osdYmlConfig: string = 'undefined';
      let dataEc2InstanceType: InstanceType;
      let mlEc2InstanceType: InstanceType;
      let volumeType: EbsDeviceVolumeType;
      let customConfigFiles: string = 'undefined';

      const x64InstanceTypes: string[] = Object.keys(x64Ec2InstanceType);
      const arm64InstanceTypes: string[] = Object.keys(arm64Ec2InstanceType);
      const vpcId: string = props?.vpcID ?? scope.node.tryGetContext('vpcId');
      const securityGroupId = props?.securityGroup ?? scope.node.tryGetContext('securityGroupId');
      const cidrRange = props?.cidr ?? scope.node.tryGetContext('cidr');
      const restrictServerAccessTo = props?.restrictServerAccessTo ?? scope.node.tryGetContext('restrictServerAccessTo');
      const serverAccessType = props?.serverAccessType ?? scope.node.tryGetContext('serverAccessType');

      const distVersion = `${props?.distVersion ?? scope.node.tryGetContext('distVersion')}`;
      if (distVersion.toString() === 'undefined') {
        throw new Error('Please provide the OS distribution version');
      }

      const securityDisabled = `${props?.securityDisabled ?? scope.node.tryGetContext('securityDisabled')}`;
      if (securityDisabled !== 'true' && securityDisabled !== 'false') {
        throw new Error('securityEnabled parameter is required to be set as - true or false');
      }
      const security = securityDisabled === 'true';

      const minDistribution = `${props?.minDistribution ?? scope.node.tryGetContext('minDistribution')}`;
      if (minDistribution !== 'true' && minDistribution !== 'false') {
        throw new Error('minDistribution parameter is required to be set as - true or false');
      }
      const minDist = minDistribution === 'true';

      const distributionUrl = `${props?.distributionUrl ?? scope.node.tryGetContext('distributionUrl')}`;
      if (distributionUrl.toString() === 'undefined') {
        throw new Error('distributionUrl parameter is required. Please provide the artifact url to download');
      }

      const dashboardUrl = `${props?.dashboardsUrl ?? scope.node.tryGetContext('dashboardsUrl')}`;

      const cpuArch = `${props?.cpuArch ?? scope.node.tryGetContext('cpuArch')}`;

      const dataInstanceType = `${props?.dataInstanceType ?? scope.node.tryGetContext('dataInstanceType')}`;
      const mlInstanceType = `${props?.mlInstanceType ?? scope.node.tryGetContext('mlInstanceType')}`;

      if (cpuArch.toString() === 'undefined') {
        throw new Error('cpuArch parameter is required. The provided value should be either x64 or arm64, any other value is invalid');
        // @ts-ignore
      } else if (Object.values(cpuArchEnum).includes(cpuArch.toString())) {
        if (cpuArch.toString() === cpuArchEnum.X64) {
          instanceCpuType = AmazonLinuxCpuType.X86_64;
          dataEc2InstanceType = getInstanceType(dataInstanceType, cpuArch.toString());
          mlEc2InstanceType = getInstanceType(mlInstanceType, cpuArch.toString());
        } else {
          instanceCpuType = AmazonLinuxCpuType.ARM_64;
          dataEc2InstanceType = getInstanceType(dataInstanceType, cpuArch.toString());
          mlEc2InstanceType = getInstanceType(mlInstanceType, cpuArch.toString());
        }
      } else {
        throw new Error('Please provide a valid cpu architecture. The valid value can be either x64 or arm64');
      }

      const singleNodeCluster = `${props?.singleNodeCluster ?? scope.node.tryGetContext('singleNodeCluster')}`;
      const isSingleNode = singleNodeCluster === 'true';

      const managerNodeCount = `${props?.managerNodeCount ?? scope.node.tryGetContext('managerNodeCount')}`;
      if (managerNodeCount.toString() === 'undefined') {
        managerCount = 3;
      } else {
        managerCount = parseInt(managerNodeCount, 10);
      }

      const dataNodeCount = `${props?.dataNodeCount ?? scope.node.tryGetContext('dataNodeCount')}`;
      if (dataNodeCount.toString() === 'undefined') {
        dataCount = 2;
      } else {
        dataCount = parseInt(dataNodeCount, 10);
      }

      const clientNodeCount = `${props?.clientNodeCount ?? scope.node.tryGetContext('clientNodeCount')}`;
      if (clientNodeCount.toString() === 'undefined') {
        clientCount = 0;
      } else {
        clientCount = parseInt(clientNodeCount, 10);
      }

      const ingestNodeCount = `${props?.ingestNodeCount ?? scope.node.tryGetContext('ingestNodeCount')}`;
      if (ingestNodeCount.toString() === 'undefined') {
        ingestCount = 0;
      } else {
        ingestCount = parseInt(clientNodeCount, 10);
      }

      const mlNodeCount = `${props?.mlNodeCount ?? scope.node.tryGetContext('mlNodeCount')}`;
      if (mlNodeCount.toString() === 'undefined') {
        mlCount = 0;
      } else {
        mlCount = parseInt(mlNodeCount, 10);
      }

      const dataSize = `${props?.dataNodeStorage ?? scope.node.tryGetContext('dataNodeStorage')}`;
      if (dataSize === 'undefined') {
        dataNodeStorage = 100;
      } else {
        dataNodeStorage = parseInt(dataSize, 10);
      }

      const inputVolumeType = `${props?.storageVolumeType ?? scope.node.tryGetContext('storageVolumeType')}`;
      if (inputVolumeType.toString() === 'undefined') {
        // use gp2 volume by default
        volumeType = getVolumeType('gp2');
      } else {
        volumeType = getVolumeType(inputVolumeType);
      }

      const mlSize = `${props?.mlNodeStorage ?? scope.node.tryGetContext('mlNodeStorage')}`;
      if (mlSize === 'undefined') {
        mlNodeStorage = 100;
      } else {
        mlNodeStorage = parseInt(mlSize, 10);
      }

      const jvmSysProps = `${props?.jvmSysProps ?? scope.node.tryGetContext('jvmSysProps')}`;

      const osConfig = `${props?.additionalConfig ?? scope.node.tryGetContext('additionalConfig')}`;
      if (osConfig.toString() !== 'undefined') {
        try {
          const jsonObj = JSON.parse(osConfig);
          ymlConfig = dump(jsonObj);
        } catch (e) {
          throw new Error(`Encountered following error while parsing additionalConfig json parameter: ${e}`);
        }
      }

      const osdConfig = `${props?.additionalOsdConfig ?? scope.node.tryGetContext('additionalOsdConfig')}`;
      if (osdConfig.toString() !== 'undefined') {
        try {
          const jsonObj = JSON.parse(osdConfig);
          osdYmlConfig = dump(jsonObj);
        } catch (e) {
          throw new Error(`Encountered following error while parsing additionalOsdConfig json parameter: ${e}`);
        }
      }

      customConfigFiles = `${props?.customConfigFiles ?? scope.node.tryGetContext('customConfigFiles')}`;

      const suffix = `${props?.suffix ?? scope.node.tryGetContext('suffix')}`;
      const networkStackSuffix = `${props?.networkStackSuffix ?? scope.node.tryGetContext('networkStackSuffix')}`;

      const use50heap = `${props?.use50PercentHeap ?? scope.node.tryGetContext('use50PercentHeap')}`;
      const use50PercentHeap = use50heap === 'true';

      const nlbScheme = `${props?.isInternal ?? scope.node.tryGetContext('isInternal')}`;
      const isInternal = nlbScheme === 'true';

      const remoteStore = `${props?.enableRemoteStore ?? scope.node.tryGetContext('enableRemoteStore')}`;
      const enableRemoteStore = remoteStore === 'true';

      const monitoringAndAlarms = `${props?.enableMonitoring ?? scope.node.tryGetContext('enableMonitoring')}`;
      const enableMonitoring = monitoringAndAlarms === 'true';

      const customRoleArn = `${props?.customRoleArn ?? scope.node.tryGetContext('customRoleArn')}`;

      let networkStackName = 'opensearch-network-stack';
      if (networkStackSuffix !== 'undefined') {
        networkStackName = `opensearch-network-stack-${networkStackSuffix}`;
      }

      const network = new NetworkStack(scope, networkStackName, {
        cidrBlock: cidrRange,
        maxAzs: 3,
        vpcId,
        securityGroupId,
        serverAccessType,
        restrictServerAccessTo,
        ...props,
      });

      this.vpc = network.vpc;
      // @ts-ignore
      this.securityGroup = network.osSecurityGroup;

      this.stacks.push(network);

      if (suffix === 'undefined') {
        infraStackName = 'opensearch-infra-stack';
      } else {
        infraStackName = `opensearch-infra-stack-${suffix}`;
      }

      // @ts-ignore
      const infraStack = new InfraStack(scope, infraStackName, {
        vpc: this.vpc,
        securityDisabled: security,
        opensearchVersion: distVersion,
        clientNodeCount: clientCount,
        cpuArch,
        cpuType: instanceCpuType,
        dataEc2InstanceType,
        mlEc2InstanceType,
        dashboardsUrl: dashboardUrl,
        dataNodeCount: dataCount,
        distributionUrl,
        ingestNodeCount: ingestCount,
        managerNodeCount: managerCount,
        minDistribution: minDist,
        mlNodeCount: mlCount,
        // @ts-ignore
        securityGroup: this.securityGroup,
        singleNodeCluster: isSingleNode,
        dataNodeStorage,
        mlNodeStorage,
        use50PercentHeap,
        isInternal,
        enableRemoteStore,
        storageVolumeType: volumeType,
        customRoleArn,
        jvmSysPropsString: jvmSysProps,
        additionalConfig: ymlConfig,
        additionalOsdConfig: osdYmlConfig,
        customConfigFiles,
        enableMonitoring,
        ...props,
      });

      infraStack.addDependency(network);

      this.stacks.push(infraStack);
    }
}
