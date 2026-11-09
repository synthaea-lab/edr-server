#!/usr/bin/env bash
# Run the unit and integration suites against a throwaway PostgreSQL.
#
# Starts docker-compose.test.yml (port 5433), waits for its healthcheck, creates the
# schema, runs both suites once, and removes the database container and volume on exit,
# whether the run passed, failed or was interrupted.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

COMPOSE=(docker compose -f docker-compose.test.yml)
export DATABASE_URL="postgresql://synthaea:synthaea_test@localhost:5433/synthaea_test"

cleanup() {
  echo ""
  echo "Stopping test database..."
  "${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Starting test database..."
# --wait blocks until the service's healthcheck (pg_isready) reports healthy,
# and fails if it never does.
"${COMPOSE[@]}" up -d --wait --wait-timeout 60

echo "Creating the schema..."
# `db push`: prisma/migrations is gitignored, so `migrate deploy` has nothing to apply.
npx prisma db push --skip-generate --accept-data-loss

echo ""
echo "Running unit tests..."
npx vitest run tests/unit

echo ""
echo "Running integration tests..."
npx vitest run tests/integration

echo ""
echo "Unit and integration tests passed."
echo "For the end-to-end acceptance tests, start the dev stack and run: npm run test:e2e"
