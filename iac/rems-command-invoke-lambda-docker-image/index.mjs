import {
  DescribeTasksCommand,
  ECSClient,
  LaunchType,
  RunTaskCommand,
} from "@aws-sdk/client-ecs";

/*
{
                "cluster": event['detail']['clusterArn'].split('/')[1],
                "subnets": subnets,
                "cpu": event['detail']['cpu'],
                "memory": event['detail']['memory'],
                "command": overrides['command'],
                "environment": overrides['environment'],
                "container_name": container_info['name'],
                "reference_id": f"{container_info['taskArn'].split('/')[1]}-{randrange(10)}",
                "task_def": event['detail']['taskDefinitionArn'].split('/')[1].split(':')[0],
                "startedBy": "CloudWatch Rules State Change to STOPPED",
                "security_groups": [os.environ['ECS_SECURITY_GROUP']]
            }
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const handler = async (event) => {
  const client = new ECSClient({});

  // the only dynamic parameter of the lambda is the "CMD" string that user wants to run
  // for REMS this is a semicolon delimited string of commands
  // e.g. migrate:test-data
  const cmd = event.cmd;

  if (!cmd) {
    return {
      error: "Lambda must be invoked with a 'cmd' string field in the event",
    };
  }

  const clusterArn = process.env["CLUSTER_ARN"];
  const clusterLogGroupName = process.env["CLUSTER_LOG_GROUP_NAME"];
  const taskDefinitionArn = process.env["TASK_DEFINITION_ARN"];
  const containerName = process.env["CONTAINER_NAME"];
  const subnets = process.env["SUBNETS"];
  const securityGroups = process.env["SECURITY_GROUPS"];

  if (
    !clusterArn ||
    !clusterLogGroupName ||
    !taskDefinitionArn ||
    !containerName ||
    !subnets ||
    !securityGroups
  )
    throw new Error(
      "Cluster settings must be passed in via environment variables"
    );

  console.log(clusterArn);
  console.log(clusterLogGroupName);
  console.log(taskDefinitionArn);
  console.log(containerName);
  console.log(subnets);
  console.log(securityGroups);

  const command = new RunTaskCommand({
    cluster: clusterArn,
    taskDefinition: taskDefinitionArn,
    launchType: LaunchType.FARGATE,
    startedBy: "REMS lambda",
    overrides: {
      containerOverrides: [
        {
          name: containerName,
          environment: [
            {
              name: "CMD",
              value: cmd,
            },
          ],
          // we ask for less cpu - mainly so these invocations will stand out in the 'list of tasks'
          cpu: 512,
        },
      ],
    },
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: subnets.split(","),
        securityGroups: securityGroups.split(","),
      },
    },
  });

  const result = await client.send(command);

  let logStreamName;

  if (result.tasks.length === 1) {
    const taskArn = result.tasks[0].taskArn;

    // whenever we know the task arn - we try to construct the name of the corresponding log stream
    // (this is a bit fragile and is dependent on only slightly documented AWS conventions)
    // (see AWSlogdriver for ECS)
    const taskArnSplit = taskArn.split("/");

    if (taskArnSplit.length === 3)
      logStreamName = `rems/rems/${taskArnSplit[2]}`;

    let lastStatus = result.tasks[0].lastStatus;

    while (lastStatus !== "STOPPED") {
      const waitResult = await client.send(
        new DescribeTasksCommand({
          cluster: clusterArn,
          tasks: [taskArn],
        })
      );

      console.log(waitResult);

      lastStatus = waitResult.tasks[0].lastStatus;

      await sleep(10000);
    }

    return {
      message: "Success",
      logGroupName: clusterLogGroupName,
      logStreamName: logStreamName,
    };
  }

  return { error: "Task not started", details: JSON.stringify(result) };
};
