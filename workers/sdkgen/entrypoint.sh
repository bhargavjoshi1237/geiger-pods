#!/bin/sh
# SDK worker entrypoint (S13 part C): reads the stage OpenAPI export and runs
# OpenAPI Generator. Defaults to the java generator; override with
# GENERATOR and PACKAGE_NAME env.
set -eu
GENERATOR="${GENERATOR:-java}"
PACKAGE_NAME="${PACKAGE_NAME:-pods-client}"
INPUT="${INPUT:-/work/api.json}"
OUT="${OUT:-/out}"
exec java -jar /opt/openapi-generator-cli.jar generate \
  -i "$INPUT" -g "$GENERATOR" -o "$OUT" \
  --additional-properties "packageName=${PACKAGE_NAME}"
