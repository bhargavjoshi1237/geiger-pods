# Pods SDK generation worker (S13 part C, P2 extended languages).
#
# Extended languages (java, android, swift, ruby, go, kotlin) render through
# OpenAPI Generator. This worker takes a stage OpenAPI export on stdin (JSON)
# and emits the generator output to /out. Pinned version for reproducibility.
FROM eclipse-temurin:21-jre AS base

ENV OPENAPI_GENERATOR_VERSION=7.8.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists \
  && curl -fsSL -o /opt/openapi-generator-cli.jar \
    "https://repo1.maven.org/maven2/org/openapitools/openapi-generator-cli/${OPENAPI_GENERATOR_VERSION}/openapi-generator-cli-${OPENAPI_GENERATOR_VERSION}.jar" \
  && java -jar /opt/openapi-generator-cli.jar version

WORKDIR /work

# Usage (invoked by the SDK job endpoint for extended languages):
#   docker build -f workers/sdkgen/Dockerfile -t pods-sdkgen:7.8.0 .
#   docker run --rm -i -v "$PWD/out:/out" pods-sdkgen:7.8.0 \
#     java -jar /opt/openapi-generator-cli.jar generate \
#       -i /work/api.json -g java -o /out --additional-properties packageName=pods-client
COPY entrypoint.sh /work/entrypoint.sh
ENTRYPOINT ["/work/entrypoint.sh"]
