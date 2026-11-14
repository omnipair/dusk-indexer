#!/usr/bin/env bash
# Disposable Linux CI host only. Exercises the production bootstrap with
# synthetic AWS responses and a local test CA; never connects to AWS/Railway.
set -euo pipefail
[[ "${CI:-}" == true && $EUID == 0 ]] || { echo 'Use a disposable root-owned Linux CI runner' >&2; exit 1; }
for path in /etc/dusk-db.conf /run/dusk-db /var/lib/dusk-postgres /opt/dusk-keeper-migrations; do
  [[ ! -e "$path" ]] || { echo 'Refusing to replace an existing database configuration' >&2; exit 1; }
done
infra=$(cd "$(dirname "$0")/.." && pwd)
scratch=$(mktemp -d)
bootstrap_pid=''
cleanup() {
  docker rm --force dusk-db >/dev/null 2>&1 || true
  [[ -z "$bootstrap_pid" ]] || wait "$bootstrap_pid" || true
  mountpoint -q /var/lib/dusk-postgres && umount /var/lib/dusk-postgres || true
  rm -rf /run/dusk-db /var/lib/dusk-postgres /opt/dusk-keeper-migrations "$scratch"
  rm -f /etc/dusk-db.conf
}
trap cleanup EXIT
install -d -m 700 "$scratch/bin" "$scratch/cert" "$scratch/backups" /run/dusk-db
mkdir -p /var/lib/dusk-postgres /opt/dusk-keeper-migrations
mount --bind /var/lib/dusk-postgres /var/lib/dusk-postgres
cp "$infra"/assets/keeper-migrations/* /opt/dusk-keeper-migrations/
chmod 755 /opt/dusk-keeper-migrations; chmod 644 /opt/dusk-keeper-migrations/*
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=Dusk disposable CI root' -keyout "$scratch/cert/ca.key" -out "$scratch/cert/ca.pem" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj '/CN=db.dusk.omnipair.fi' -keyout "$scratch/cert/server.key" -out "$scratch/cert/server.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:db.dusk.omnipair.fi\nextendedKeyUsage=serverAuth\n' > "$scratch/cert/extensions"
openssl x509 -req -days 2 -in "$scratch/cert/server.csr" -CA "$scratch/cert/ca.pem" -CAkey "$scratch/cert/ca.key" -CAcreateserial -extfile "$scratch/cert/extensions" -out "$scratch/cert/server.pem" >/dev/null 2>&1
cat > "$scratch/bin/aws" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  'secretsmanager get-secret-value')
    case "$*" in
      *root-secret*) password=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ;;
      *app-secret*) password=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB ;;
      *keeper-secret*) password=CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC ;;
      *) exit 1 ;;
    esac
    printf '{"password":"%s"}\n' "$password"
    ;;
  'acm export-certificate')
    openssl pkey -in "$TEST_SCRATCH/cert/server.key" -aes256 -passout file:/run/dusk-db/export-passphrase -out "$TEST_SCRATCH/cert/encrypted.key" 2>/dev/null
    jq -n --rawfile PrivateKey "$TEST_SCRATCH/cert/encrypted.key" --rawfile Certificate "$TEST_SCRATCH/cert/server.pem" --rawfile CertificateChain "$TEST_SCRATCH/cert/ca.pem" '{PrivateKey:$PrivateKey,Certificate:$Certificate,CertificateChain:$CertificateChain}'
    ;;
  's3 cp')
    [[ "$3" == - && "$4" == s3://dusk-test-backups/postgres/* ]]
    cat > "$TEST_SCRATCH/backups/$(basename "$(dirname "$4")").dump"
    ;;
  'cloudwatch put-metric-data') ;;
  *) exit 1 ;;
esac
SH
chmod 700 "$scratch/bin/aws"
cat > /etc/dusk-db.conf <<'CONFIG'
AWS_REGION=ap-southeast-1
CERTIFICATE_ARN=disposable-test-certificate
ROOT_SECRET_ARN=root-secret
APP_SECRET_ARN=app-secret
KEEPER_SECRET_ARN=keeper-secret
BACKUP_BUCKET=dusk-test-backups
DATABASE_IMAGE=timescale/timescaledb:2.29.2-pg17@sha256:bc8527e62f70f0766b29515077965025872fabb5349db421565f69ee273baf2d
# CI runners do not reserve the production database's 16 GiB of RAM.
DATABASE_SHARED_BUFFERS=128MB
CONFIG
export PATH="$scratch/bin:$PATH" TEST_SCRATCH="$scratch"
bash "$infra/assets/database.sh" start > "$scratch/bootstrap.log" 2>&1 &
bootstrap_pid=$!
ready=false
for _ in $(seq 1 120); do
  if docker exec --user postgres dusk-db psql -XAt -U postgres -d dusk_keeper_mainnet -c 'SELECT count(*) FROM keeper_release.applied_migrations' 2>/dev/null | rg -qx 3; then ready=true; break; fi
  kill -0 "$bootstrap_pid" 2>/dev/null || { echo 'Production database bootstrap failed'; exit 1; }
  sleep 2
done
[[ "$ready" == true ]]
[[ "$(docker exec dusk-db id -u postgres)" == 70 ]]
docker exec --user postgres dusk-db psql -XAt -U postgres -d dusk_mainnet -c "SELECT version(),extversion FROM pg_extension WHERE extname='timescaledb'"
docker exec --user postgres dusk-db psql -XAt -U postgres -d dusk_mainnet -c "SELECT rolname FROM pg_roles WHERE rolname IN ('dusk_app','keeper_writer') AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb" | sort | diff - <(printf 'dusk_app\nkeeper_writer\n')
docker exec --user postgres dusk-db bash /keeper-migrations/initialize.sh > /dev/null
connection="host=db.dusk.omnipair.fi hostaddr=127.0.0.1 port=5432 user=dusk_app dbname=dusk_mainnet"
export PGPASSWORD=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
psql "$connection sslmode=verify-full sslrootcert=$scratch/cert/ca.pem" -XAtqc 'SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()' | rg -qx t
if psql "$connection sslmode=disable" -XAtqc 'SELECT 1' >/dev/null 2>&1; then echo 'Non-TLS connection unexpectedly accepted'; exit 1; fi
if psql "$connection sslmode=verify-full sslrootcert=/etc/ssl/certs/ca-certificates.crt" -XAtqc 'SELECT 1' >/dev/null 2>&1; then echo 'Untrusted certificate unexpectedly accepted'; exit 1; fi
if psql "host=wrong.invalid hostaddr=127.0.0.1 port=5432 user=dusk_app dbname=dusk_mainnet sslmode=verify-full sslrootcert=$scratch/cert/ca.pem" -XAtqc 'SELECT 1' >/dev/null 2>&1; then echo 'Wrong hostname unexpectedly accepted'; exit 1; fi
unset PGPASSWORD
bash "$infra/assets/database.sh" backup
for database in dusk_mainnet dusk_keeper_mainnet; do
  docker exec -i --user postgres dusk-db pg_restore --list < "$scratch/backups/$database.dump" >/dev/null
done
bash "$infra/assets/database.sh" refresh
bash "$infra/assets/database.sh" metrics
echo 'Production bootstrap, journal replay, TLS refusal, backups and certificate reload passed'
