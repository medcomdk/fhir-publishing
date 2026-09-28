#!/usr/bin/env bash

set -euo pipefail

data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
install_root="$data_home/medcom-firely-validation"
user_prefix="$HOME/.local"
bin_dir="$user_prefix/bin"
dotnet_dir="$install_root/dotnet"
node_dir="$install_root/node"
temp_dir="$(mktemp -d)"
node_executable="${1:-}"

trap 'rm -rf "$temp_dir"' EXIT

download() {
  local url="$1"
  local destination="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$destination"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$destination" "$url"
  elif [ -x "$node_executable" ]; then
    "$node_executable" -e '
      const fs = require("node:fs");
      const { Readable } = require("node:stream");
      const { pipeline } = require("node:stream/promises");
      (async () => {
        const response = await fetch(process.argv[1]);
        if (!response.ok || !response.body) {
          throw new Error(`${response.status} ${response.statusText}`);
        }
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(process.argv[2]));
      })();
    ' "$url" "$destination"
  else
    echo "Downloading tools requires curl, wget, or a Node.js executable." >&2
    exit 1
  fi
}

mkdir -p "$bin_dir" "$install_root"
export PATH="$bin_dir:$node_dir/bin:$dotnet_dir:${PATH:-}"

if ! dotnet --list-sdks 2>/dev/null | grep -q '^8\.'; then
  echo "Installing .NET SDK 8..."

  case "$(uname -s)" in
    Linux) dotnet_os=linux ;;
    Darwin) dotnet_os=osx ;;
    *) echo ".NET SDK installation is supported on Linux and macOS." >&2; exit 1 ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64) dotnet_arch=x64 ;;
    arm64|aarch64) dotnet_arch=arm64 ;;
    *) echo "Unsupported .NET architecture: $(uname -m)" >&2; exit 1 ;;
  esac

  dotnet_archive="$temp_dir/dotnet-sdk-$dotnet_os-$dotnet_arch.tar.gz"
  download "https://aka.ms/dotnet/8.0/dotnet-sdk-$dotnet_os-$dotnet_arch.tar.gz" "$dotnet_archive"
  mkdir -p "$dotnet_dir"
  tar -xzf "$dotnet_archive" -C "$dotnet_dir"
fi

if [ -x "$dotnet_dir/dotnet" ]; then
  export DOTNET_ROOT="$dotnet_dir"
  if [ "$(uname -s)" = Linux ]; then
    export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=true
    export DOTNET_SYSTEM_GLOBALIZATION_PREDEFINED_CULTURES_ONLY=false
  fi
fi

if ! command -v fhir >/dev/null 2>&1; then
  echo "Installing Firely Terminal..."
  dotnet tool install Firely.Terminal --tool-path "$bin_dir"
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Installing Node.js and npm..."

  case "$(uname -s)" in
    Linux) node_os=linux ;;
    Darwin) node_os=darwin ;;
    *) echo "Node.js installation is supported on Linux and macOS." >&2; exit 1 ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64) node_arch=x64 ;;
    arm64|aarch64) node_arch=arm64 ;;
    *) echo "Unsupported Node.js architecture: $(uname -m)" >&2; exit 1 ;;
  esac

  node_url=https://nodejs.org/dist/latest-v24.x
  download "$node_url/SHASUMS256.txt" "$temp_dir/SHASUMS256.txt"
  node_archive="$(awk -v suffix="-$node_os-$node_arch.tar.gz" '$2 ~ suffix "$" { print $2; exit }' "$temp_dir/SHASUMS256.txt")"

  if [ -z "$node_archive" ]; then
    echo "No Node.js download is available for $node_os-$node_arch." >&2
    exit 1
  fi

  download "$node_url/$node_archive" "$temp_dir/$node_archive"

  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$temp_dir" && grep "  $node_archive$" SHASUMS256.txt | sha256sum --check -)
  else
    (cd "$temp_dir" && grep "  $node_archive$" SHASUMS256.txt | shasum --algorithm 256 --check -)
  fi

  mkdir -p "$node_dir"
  tar -xzf "$temp_dir/$node_archive" --strip-components=1 -C "$node_dir"
fi

if ! command -v sushi >/dev/null 2>&1; then
  echo "Installing SUSHI..."
  npm install --global --prefix "$user_prefix" --no-audit --no-fund fsh-sushi
fi

dotnet --list-sdks | grep -q '^8\.'
fhir --version
npm --version
sushi --version

echo "Firely validation tools are ready."
