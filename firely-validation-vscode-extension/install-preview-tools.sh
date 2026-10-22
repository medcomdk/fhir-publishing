#!/usr/bin/env bash
# Installs only the Ruby/Jekyll dependencies used by live preview.
set -euo pipefail

install_root="${1:?Usage: install-preview-tools.sh install-directory}"
gem_home="$install_root/gems"
launcher="$install_root/bin/jekyll"
candidate="$install_root/bin/.jekyll-$$"
trap 'rm -f -- "$candidate"' EXIT

if [[ -x "$launcher" ]] && "$launcher" --version; then
  echo "Preview dependencies are ready."
  exit 0
fi

ruby_usable() {
  command -v ruby >/dev/null 2>&1 && ruby -rrubygems -e \
    'exit(Gem::Version.new(RUBY_VERSION) >= Gem::Version.new("3.1") ? 0 : 1)' 2>/dev/null
}

build_tools_available() {
  command -v make >/dev/null 2>&1 && command -v cc >/dev/null 2>&1 && \
    ruby -rrbconfig -e 'exit(File.file?(File.join(RbConfig::CONFIG["rubyhdrdir"], "ruby.h")) ? 0 : 1)' 2>/dev/null
}

as_admin() {
  if [[ "$(id -u)" == 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "Installing Ruby/build dependencies needs administrator access. Install Ruby 3.1+, Ruby headers, make and a C compiler, then retry preview." >&2
    exit 1
  fi
}

case "$(uname -s)" in
  Linux)
    if ! ruby_usable || ! build_tools_available; then
      echo "Installing Ruby and the build dependencies needed by Jekyll gems..."
      if command -v apt-get >/dev/null 2>&1; then
        as_admin apt-get update
        as_admin apt-get install -y ruby-full build-essential zlib1g-dev
      elif command -v dnf >/dev/null 2>&1; then
        as_admin dnf install -y ruby ruby-devel rubygems gcc gcc-c++ make zlib-devel
      elif command -v pacman >/dev/null 2>&1; then
        as_admin pacman -S --needed --noconfirm ruby base-devel zlib
      elif command -v zypper >/dev/null 2>&1; then
        as_admin zypper --non-interactive install ruby ruby-devel gcc gcc-c++ make zlib-devel
      else
        echo "No supported package manager found. Install Ruby 3.1+, Ruby headers, make and a C compiler, then retry preview: https://jekyllrb.com/docs/installation/" >&2
        exit 1
      fi
    fi
    ;;
  Darwin)
    # GUI-launched VS Code may not have Homebrew on PATH.
    if ! command -v brew >/dev/null 2>&1; then
      for brew_bin in /opt/homebrew/bin /usr/local/bin; do
        if [[ -x "$brew_bin/brew" ]]; then export PATH="$brew_bin:$PATH"; break; fi
      done
    fi
    if ! ruby_usable || ! build_tools_available; then
      if ! command -v brew >/dev/null 2>&1; then
        echo "Ruby installation on macOS requires Homebrew. Install it from https://brew.sh or install Ruby 3.1+ yourself, then retry preview." >&2
        exit 1
      fi
      echo "Installing Ruby with Homebrew..."
      brew install ruby@3.4
      export PATH="$(brew --prefix ruby@3.4)/bin:$PATH"
    fi
    ;;
  *)
    echo "Automatic preview dependency installation supports Linux, macOS and Windows (install-preview-tools.ps1)." >&2
    exit 1
    ;;
esac

if ! ruby_usable; then
  echo "The available Ruby is too old. Install Ruby 3.1+ and retry preview: https://jekyllrb.com/docs/installation/" >&2
  exit 1
fi
ruby_executable="$(ruby -rrbconfig -e 'print RbConfig.ruby')"
mkdir -p -- "$gem_home" "$install_root/bin"
# These variables are private to this installer and the preview launcher.
export GEM_HOME="$gem_home" GEM_PATH="$gem_home"
echo "Installing Jekyll gems in $gem_home..."
"$ruby_executable" -S gem install --norc --clear-sources --source https://rubygems.org \
  --install-dir "$gem_home" --bindir "$gem_home/bin" --no-document jekyll --version 4.4.1
"$ruby_executable" -S gem install --norc --clear-sources --source https://rubygems.org \
  --install-dir "$gem_home" --bindir "$gem_home/bin" --no-document bundler --version '~> 2.6.0'

# Publish a working launcher atomically; do not change shell profiles or global gems.
{
  echo '#!/usr/bin/env bash'
  printf 'export GEM_HOME=%q\n' "$gem_home"
  echo 'export GEM_PATH="$GEM_HOME"'
  printf 'export PATH=%q:"$PATH"\n' "$(dirname -- "$ruby_executable")"
  printf 'exec %q %q "$@"\n' "$ruby_executable" "$gem_home/bin/jekyll"
} > "$candidate"
chmod +x "$candidate"
"$candidate" --version
mv -f -- "$candidate" "$launcher"
echo "Preview dependencies are ready."
