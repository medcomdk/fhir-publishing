ARG DEBIAN_FRONTEND=noninteractive
FROM ubuntu:24.04
LABEL maintainer="Oliver Winther"

RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends \
        build-essential \
        openjdk-25-jdk-headless \
        nodejs npm \
        python3 python3-pip python3-venv \
        jq \
        git curl \
        ruby ruby-dev \
        libfreetype6 fontconfig \
        ttf-mscorefonts-installer \
        dotnet-sdk-8.0 \
 && rm -rf /var/lib/apt/lists/*

RUN wget https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 -O /usr/local/bin/yq &&\
    chmod +x /usr/local/bin/yq

# Ruby tooling
RUN gem install --no-document bundler jekyll

# FHIR tooling
RUN npm install -g fsh-sushi
RUN dotnet tool install -g firely.terminal

# Make .NET global tools available in every container process and shell.
ENV PATH="/root/.dotnet/tools:${PATH}"

# Setup python virtual environment
RUN python3 -m venv /pythonvenv

# Pre-download the IG Publisher JAR
ARG IG_PUB_VERSION # Provided by github workflow
RUN mkdir input-cache \
&& curl -fsSL -o input-cache/publisher.jar \
"https://github.com/HL7/fhir-ig-publisher/releases/download/${IG_PUB_VERSION}/publisher.jar"
