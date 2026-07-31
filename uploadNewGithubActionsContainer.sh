#!/bin/sh
set -e

read -p "Enter publisher version (e.g., 2.0.30): " VERSION
read -p "Enter tag suffix (e.g., -medcom-update-thingie): " TAG_SUFFIX


docker build -t ghcr.io/medcomdk/medcom-github-actions-container:$VERSION$TAG_SUFFIX \
--build-arg IG_PUB_VERSION=$VERSION . \
&& \
docker push ghcr.io/medcomdk/medcom-github-actions-container:$VERSION$TAG_SUFFIX

sed -i -E \
  's|(container:[[:space:]]+[^[:space:]]+):[^[:space:]]+|\1:'"${VERSION}${TAG_SUFFIX}"'|' \
  "./.github/workflows/qa-report.yaml"