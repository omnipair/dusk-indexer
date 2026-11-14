#!/usr/bin/env bash
set -euo pipefail
# /etc/dusk-db.conf contains public resource identities only.
# shellcheck source=/dev/null
source /etc/dusk-db.conf
umask 077
install -d -m 700 /run/dusk-db
export AWS_DEFAULT_REGION="$AWS_REGION"

secret_password() {
  local value
  value=$(aws secretsmanager get-secret-value --secret-id "$1" --query SecretString --output text | jq -r .password)
  [[ "$value" =~ ^[A-Za-z0-9]{32}$ ]] || { echo 'Invalid database secret format' >&2; exit 1; }
  printf '%s' "$value"
}

refresh_certificate() {
  install -d -m 750 -o 70 -g 70 /run/dusk-db/tls
  openssl rand -hex 32 | tr -d '\n' > /run/dusk-db/export-passphrase
  aws acm export-certificate --certificate-arn "$CERTIFICATE_ARN" --passphrase fileb:///run/dusk-db/export-passphrase > /run/dusk-db/export.json
  jq -r .PrivateKey /run/dusk-db/export.json > /run/dusk-db/encrypted-key.pem
  openssl pkey -in /run/dusk-db/encrypted-key.pem -passin file:/run/dusk-db/export-passphrase -out /run/dusk-db/tls/key.pem
  jq -r '.Certificate + .CertificateChain' /run/dusk-db/export.json > /run/dusk-db/tls/chain.pem
  openssl x509 -in /run/dusk-db/tls/chain.pem -noout -checkhost db.dusk.omnipair.fi > /dev/null
  chown 70:70 /run/dusk-db/tls/*.pem
  chmod 600 /run/dusk-db/tls/key.pem
  rm /run/dusk-db/export-passphrase /run/dusk-db/export.json /run/dusk-db/encrypted-key.pem
}

case "${1:-start}" in
  metrics)
    mountpoint -q /var/lib/dusk-postgres
    used=$(df --output=pcent /var/lib/dusk-postgres | tail -1 | tr -dc '0-9')
    aws cloudwatch put-metric-data --namespace Dusk/Database --metric-data "MetricName=DiskUsedPercent,Unit=Percent,Value=$used"
    exit 0
    ;;
  refresh)
    refresh_certificate
    docker kill --signal=HUP dusk-db > /dev/null
    exit 0
    ;;
  backup)
    # No password is passed in arguments or written to logs. The local Unix
    # socket is inside the owned database container.
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    for database in dusk_mainnet dusk_keeper_mainnet; do
      docker exec --user postgres dusk-db pg_dump -U postgres -Fc "$database" |
        aws s3 cp - "s3://$BACKUP_BUCKET/postgres/$database/$stamp.dump" --sse AES256 --no-progress --only-show-errors
    done
    aws cloudwatch put-metric-data --namespace Dusk/Database --metric-data 'MetricName=LogicalBackupSuccess,Unit=Count,Value=1'
    exit 0
    ;;
esac

refresh_certificate
mountpoint -q /var/lib/dusk-postgres
ROOT_PASSWORD=$(secret_password "$ROOT_SECRET_ARN")
APP_PASSWORD=$(secret_password "$APP_SECRET_ARN")
KEEPER_PASSWORD=$(secret_password "$KEEPER_SECRET_ARN")
printf 'POSTGRES_PASSWORD=%s\nPOSTGRES_DB=dusk_mainnet\nPOSTGRES_HOST_AUTH_METHOD=scram-sha-256\n' "$ROOT_PASSWORD" > /run/dusk-db/docker.env
cat > /run/dusk-db/init.sql <<SQL
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE ROLE dusk_app LOGIN PASSWORD '$APP_PASSWORD' NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CONNECT, TEMPORARY ON DATABASE dusk_mainnet TO dusk_app;
GRANT CREATE ON SCHEMA public TO dusk_app;
CREATE SCHEMA dusk_ingestion AUTHORIZATION dusk_app;
CREATE ROLE keeper_writer LOGIN PASSWORD '$KEEPER_PASSWORD' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE dusk_keeper_mainnet OWNER keeper_writer;
SQL
chmod 644 /run/dusk-db/init.sql
cat > /run/dusk-db/require-tls.sh <<'SH'
# Sourced by the official postgres entrypoint after database creation.
{ printf 'hostnossl all all 0.0.0.0/0 reject\nhostnossl all all ::/0 reject\n'; cat "$PGDATA/pg_hba.conf"; } > "$PGDATA/pg_hba.conf.new"
mv "$PGDATA/pg_hba.conf.new" "$PGDATA/pg_hba.conf"
SH
chmod 644 /run/dusk-db/require-tls.sh
unset ROOT_PASSWORD APP_PASSWORD KEEPER_PASSWORD

docker pull "$DATABASE_IMAGE" > /dev/null
docker rm dusk-db > /dev/null 2>&1 || true
exec docker run --name dusk-db --env-file /run/dusk-db/docker.env --shm-size=1g \
  --publish 5432:5432 \
  --mount type=bind,source=/var/lib/dusk-postgres,target=/var/lib/postgresql/data \
  --mount type=bind,source=/run/dusk-db/tls,target=/tls,readonly \
  --mount type=bind,source=/run/dusk-db/init.sql,target=/docker-entrypoint-initdb.d/010-users.sql,readonly \
  --mount type=bind,source=/run/dusk-db/require-tls.sh,target=/docker-entrypoint-initdb.d/020-require-tls.sh,readonly \
  --mount type=bind,source=/opt/dusk-keeper-migrations,target=/keeper-migrations,readonly \
  --mount type=bind,source=/opt/dusk-keeper-migrations/initialize.sh,target=/docker-entrypoint-initdb.d/030-keeper-journal.sh,readonly \
  "$DATABASE_IMAGE" \
  -c "shared_buffers=${DATABASE_SHARED_BUFFERS:-5722MB}" -c work_mem=7629kB -c max_connections=100 \
  -c ssl=on -c ssl_cert_file=/tls/chain.pem -c ssl_key_file=/tls/key.pem \
  -c log_statement=none -c log_min_error_statement=panic
