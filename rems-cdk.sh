#!/bin/zsh

set -o errexit

# we can fetch these settings however we want - depending on our security settings - feel free to replace
# with any technique that makes sense for you
# these are the REMS settings that are almost certainly going to need to change for
# each deployment (i.e the domain name).
# there are other REMS settings that you might like to change (REMS features etc) - for those
# see iac/rems-docker-image/config.edn

# the namespace must pre-exist as a CloudMap namespace in the account of deployment
# (we also have an annoying CDK bug that means we *also* have to specify the id - hopefully this
#  is fixed and we can just lookup by name)
CLOUD_MAP_NAMESPACE=$(head -1 rems-cloudmap-namespace.txt)
CLOUD_MAP_ID=$(head -2 rems-cloudmap-namespace.txt | tail -1)

HOSTED_PREFIX="rems"
HOSTED_ZONE_NAME="biocommons.dev"
HOSTED_ZONE_CERT="arn:aws:acm:ap-southeast-2:497070645708:certificate/f01d2230-149f-4062-967e-86cf74df6a61"
OIDC_METADATA_URL="https://rems-hgpp-trial.au.auth0.com/.well-known/openid-configuration"
SMTP_HOST="email-smtp.ap-southeast-2.amazonaws.com"
SMTP_MAIL_FROM="rems@biocommons.dev"

(cd iac; npx cdk "$@" \
   --toolkit-stack-name CDKToolkitNew \
   --context "cloudMapNamespace=$CLOUD_MAP_NAMESPACE" \
   --context "cloudMapId=$CLOUD_MAP_ID" \
   --context "hostedPrefix=$HOSTED_PREFIX" \
   --context "hostedZoneName=$HOSTED_ZONE_NAME" \
   --context "hostedZoneCert=$HOSTED_ZONE_CERT" \
   --context "oidcMetadataUrl=$OIDC_METADATA_URL" \
   --context "oidcClientId=$(aws ssm get-parameter --name 'oauth_client_id' --output text --query 'Parameter.Value')" \
   --context "oidcClientSecret=$(aws ssm get-parameter --name 'oauth_client_secret' --output text --query 'Parameter.Value')" \
   --context "smtpHost=$SMTP_HOST" \
   --context "smtpMailFrom=$SMTP_MAIL_FROM" \
   --context "smtpUser=$(aws ssm get-parameter --name 'smtp_send_user' --output text --query 'Parameter.Value')" \
   --context "smtpPassword=$(aws ssm get-parameter --name 'smtp_send_password' --output text --query 'Parameter.Value')" \
   )
