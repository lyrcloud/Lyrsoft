#!/usr/bin/env bash
# Deploys Lyrsoft Work to https://lyrsoft.com:
#   1. the work API and inbound mail (infra/aws/lyrsoft-work-api.yml, code in api/work/ and api/mail/)
#   2. mail: SES identities for every mail domain, the active receipt rule set, and the DNS records to add
#   3. lyrsoft.com sign-in URLs on the shared Lyrcloud Cognito app client (first run only)
#   4. the lyrsoft.com TLS certificate (first run: prints DNS records to add in Cloudflare, then waits)
#   5. hosting (infra/aws/lyrsoft-site.yml), the website (lyrsoft/home.html) and the app (lyrsoft/, served at /app/)
# Safe to re-run; later runs just ship new code.
set -euo pipefail

DOMAIN="${DOMAIN:-lyrsoft.com}"
ARTIFACTS_BUCKET="${ARTIFACTS_BUCKET:-lyrcloud-deploy-artifacts}"
API_STACK="${API_STACK:-lyrsoft-work-api}"
SITE_STACK="${SITE_STACK:-lyrsoft-site}"
COGNITO_STACK="${COGNITO_STACK:-lyrcloud-cognito}"
export AWS_REGION="${AWS_REGION:-us-east-1}" # CloudFront certificates must live in us-east-1

output() { aws cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
param() { aws cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Parameters[?ParameterKey=='$2'].ParameterValue" --output text; }

[[ -d node_modules ]] || npm ci
npm test

# 1. Work API and inbound mail ---------------------------------------------------------------
# Both Lambdas are bundled with their dependencies (AWS SDK, postal-mime) into one zip.
build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT
npx esbuild work=api/work/index.mjs inbound=api/mail/inbound.mjs --bundle --platform=node --target=node22 \
  --format=esm --minify-syntax --outdir="$build" --out-extension:.js=.mjs --log-level=warning \
  --banner:js="import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);"
(cd "$build" && zip -q -X code.zip work.mjs inbound.mjs)
key="work-api/$(sha256sum "$build/code.zip" | cut -d' ' -f1).zip"
aws s3 cp "$build/code.zip" "s3://$ARTIFACTS_BUCKET/$key" >/dev/null
# MAIL_DOMAINS=a.com,b.com changes the receiving domains; otherwise the stack keeps its current list.
aws cloudformation deploy --stack-name "$API_STACK" --template-file infra/aws/lyrsoft-work-api.yml \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
  --parameter-overrides "LambdaCodeS3Key=$key" ${MAIL_DOMAINS:+"MailDomains=$MAIL_DOMAINS"}
API_BASE="$(output "$API_STACK" WorkApiBaseUrl)"
echo "Work API: $API_BASE"

# 2. Mail -------------------------------------------------------------------------------------
MAIL_DOMAINS="$(param "$API_STACK" MailDomains)"
RULE_SET="$(output "$API_STACK" ReceiptRuleSetName)"
active="$(aws ses describe-active-receipt-rule-set --query Metadata.Name --output text 2>/dev/null || true)"
if [[ -z "$active" || "$active" == "None" ]]; then
  aws ses set-active-receipt-rule-set --rule-set-name "$RULE_SET"
  echo "Activated SES receipt rule set $RULE_SET"
elif [[ "$active" != "$RULE_SET" ]]; then
  echo "WARNING: SES receipt rule set '$active' is active, not '$RULE_SET'. Only one can be active; mail won't reach Lyrsoft until you switch."
fi

dns="$build/mail-dns.txt"
for domain in ${MAIL_DOMAINS//,/ }; do
  if ! aws sesv2 get-email-identity --email-identity "$domain" >/dev/null 2>&1; then
    aws sesv2 create-email-identity --email-identity "$domain" >/dev/null
    echo "Created SES identity for $domain"
  fi
  {
    echo "  $domain"
    echo "    MX     $domain  ->  10 inbound-smtp.$AWS_REGION.amazonaws.com"
    # DMARC: mail is DKIM-signed as the domain, so a valid DMARC record lets it pass checks at Gmail/Outlook.
    dmarc="$(curl -s "https://cloudflare-dns.com/dns-query?name=_dmarc.$domain&type=TXT" -H 'accept: application/dns-json' |
      python3 -c 'import json,sys; print(" ".join(a["data"] for a in json.load(sys.stdin).get("Answer", [])))' 2>/dev/null || true)"
    if [[ "$dmarc" != *"v=DMARC1"* ]]; then
      echo "    TXT    _dmarc.$domain  ->  \"v=DMARC1; p=none;\"   (replace any existing _dmarc TXT${dmarc:+: currently $dmarc})"
    fi
    if [[ "$(aws sesv2 get-email-identity --email-identity "$domain" --query DkimAttributes.Status --output text)" != "SUCCESS" ]]; then
      for token in $(aws sesv2 get-email-identity --email-identity "$domain" --query DkimAttributes.Tokens --output text); do
        echo "    CNAME  ${token}._domainkey.$domain  ->  ${token}.dkim.amazonses.com"
      done
    fi
  } >>"$dns"
done
echo
echo "Mail DNS records (Cloudflare, Proxy status = DNS only). Already-present records can be skipped:"
cat "$dns"

# 3. Sign-in callback URLs -------------------------------------------------------------------
callbacks="$(param "$COGNITO_STACK" CallbackUrls)"
if [[ ",$callbacks," != *",https://$DOMAIN/callback.html,"* ]]; then
  logouts="$(param "$COGNITO_STACK" LogoutUrls)"
  params="$build/cognito-params.json"
  CALLBACKS="$callbacks,https://$DOMAIN/callback.html,http://localhost:5174/callback.html" \
  LOGOUTS="$logouts,https://$DOMAIN/index.html,http://localhost:5174/index.html" \
  KEEP="$(aws cloudformation describe-stacks --stack-name "$COGNITO_STACK" --query 'Stacks[0].Parameters[].ParameterKey' --output text)" \
    python3 -c '
import json, os
changed = {"CallbackUrls": os.environ["CALLBACKS"], "LogoutUrls": os.environ["LOGOUTS"]}
params = [{"ParameterKey": k, "ParameterValue": changed[k]} if k in changed else {"ParameterKey": k, "UsePreviousValue": True}
          for k in os.environ["KEEP"].split()]
print(json.dumps(params))' >"$params"
  aws cloudformation update-stack --stack-name "$COGNITO_STACK" --use-previous-template \
    --capabilities CAPABILITY_IAM --parameters "file://$params" >/dev/null
  aws cloudformation wait stack-update-complete --stack-name "$COGNITO_STACK"
  echo "Added https://$DOMAIN sign-in URLs to the Cognito app client"
fi

# 4. Certificate -----------------------------------------------------------------------------
cert="$(aws acm list-certificates --query "CertificateSummaryList[?DomainName=='$DOMAIN'].CertificateArn | [0]" --output text)"
if [[ -z "$cert" || "$cert" == "None" ]]; then
  cert="$(aws acm request-certificate --domain-name "$DOMAIN" --subject-alternative-names "www.$DOMAIN" \
    --validation-method DNS --query CertificateArn --output text)"
  sleep 10 # validation records take a moment to appear
fi
if [[ "$(aws acm describe-certificate --certificate-arn "$cert" --query Certificate.Status --output text)" != "ISSUED" ]]; then
  echo
  echo "Add these DNS records in Cloudflare ($DOMAIN zone), with Proxy status = DNS only:"
  aws acm describe-certificate --certificate-arn "$cert" \
    --query 'Certificate.DomainValidationOptions[].ResourceRecord.[Type,Name,Value]' --output text | sort -u |
    while read -r type name value; do echo "  $type  $name  ->  $value"; done
  echo "Waiting for the certificate to be issued (usually a few minutes after the records exist)..."
  aws acm wait certificate-validated --certificate-arn "$cert"
fi

# 5. Hosting and app -------------------------------------------------------------------------
aws cloudformation deploy --stack-name "$SITE_STACK" --template-file infra/aws/lyrsoft-site.yml \
  --no-fail-on-empty-changeset --parameter-overrides "DomainName=$DOMAIN" "CertificateArn=$cert"
BUCKET="$(output "$SITE_STACK" BucketName)"
DISTRIBUTION="$(output "$SITE_STACK" DistributionId)"
CF_DOMAIN="$(output "$SITE_STACK" DistributionDomainName)"

LYRSOFT_API_BASE="$API_BASE" node scripts/build-lyrsoft.mjs
aws s3 sync dist-lyrsoft/assets/ "s3://$BUCKET/assets/" --cache-control "public,max-age=31536000,immutable"
aws s3 sync dist-lyrsoft/ "s3://$BUCKET/" --exclude "*" --include "*.html" \
  --cache-control "public,max-age=0,must-revalidate" --content-type "text/html; charset=utf-8"
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION" --paths "/*" >/dev/null

echo
echo "Deployed. If lyrsoft.com doesn't load yet, add these in Cloudflare (Proxy status = DNS only):"
echo "  CNAME  $DOMAIN      ->  $CF_DOMAIN"
echo "  CNAME  www.$DOMAIN  ->  $CF_DOMAIN"
