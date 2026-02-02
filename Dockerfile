ARG DEBIAN_FRONTEND=noninteractive
FROM ubuntu:24.04
LABEL maintainer="Oliver Winther"

ARG IG_PUB_VERSION # Provided by github workflow

RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends \
        build-essential \
        openjdk-21-jdk-headless \
        nodejs npm \
        python3 python3-pip python3-venv \
        jq yq \
        git curl \
        ruby ruby-dev \
        libfreetype6 fontconfig \
        ttf-mscorefonts-installer \
 && rm -rf /var/lib/apt/lists/*

# Ruby tooling
RUN gem install --no-document bundler jekyll

# Node tooling
RUN npm install -g fsh-sushi

# Pre-download the IG Publisher JAR
RUN mkdir input-cache \
&& curl -fsSL -o input-cache/publisher.jar \
"https://github.com/HL7/fhir-ig-publisher/releases/download/${IG_PUB_VERSION}/publisher.jar"

# Setup python virtual environment
RUN python3 -m venv /pythonvenv