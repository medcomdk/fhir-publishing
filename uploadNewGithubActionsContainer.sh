#!/bin/sh
set -e

read -p "Enter publisher version (e.g., 2.0.30): " VERSION


docker build -t ghcr.io/medcomdk/medcom-github-actions-container:$VERSION \
--build-arg IG_PUB_VERSION=$VERSION . \
&& \
docker push ghcr.io/medcomdk/medcom-github-actions-container:$VERSION

sed -i -E \
  's|(container:[[:space:]]+[^[:space:]]+):[^[:space:]]+|\1:'"${VERSION}"'|' \
  "./.github/workflows/qa-report.yaml"