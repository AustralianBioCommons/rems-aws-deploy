#!/bin/zsh

#
# Executes a REMS CMD inside the deployed REMS environment
# This needs to execute in a environment with permissions into the AWS account
# where the REMS CDK has been deployed. Because this
#


set -o errexit

# the namespace must pre-exist as a CloudMap namespace in the account of deployment
CLOUD_MAP_NAMESPACE=$(head -1 rems-cloudmap-namespace.txt)

# once deployed our CDK will register the lambda into the namespace
LAMBDA_ARN=$(aws servicediscovery discover-instances \
           --namespace-name "$CLOUD_MAP_NAMESPACE" \
           --service-name "rems" \
           --output text --query "Instances[].Attributes.lambdaArn")

echo "Task command executions can take a while - this CLI tool will wait for operations to finish (possibly 10 minutes)"

# annoyingly the aws lambda invoke *only* writes data into a file - can't output it to stdout
# so we make a temp file to hold the result and set a trap to delete it
temp_file=$(mktemp)

trap "rm -f $temp_file" 0 2 3 15

# our lambda knows how to pass cmd line strings to a spun up REMS container just for CMD invoking
aws lambda invoke --function-name "$LAMBDA_ARN" \
           --cli-read-timeout 600 \
           --cli-binary-format raw-in-base64-out \
           --payload "{\"cmd\":\"$1\"}" \
           "$temp_file"

# the lambda returns details of where all its logs went
LG=$(jq < "$temp_file" -r '.logGroupName')
LS=$(jq < "$temp_file" -r '.logStreamName')

# and now we can print the log output (which is the CMD output)
aws logs tail "$LG" --log-stream-names "$LS"
