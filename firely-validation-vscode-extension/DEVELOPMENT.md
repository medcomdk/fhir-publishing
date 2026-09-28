# Developing MedCom Firely Validation

This guide is for extension contributors. The [extension README](README.md) is the user documentation displayed by VS Code.

## Build and package

Use Node.js 22 or newer. Node.js 24 is the recommended build version and is recorded in `.nvmrc`. The locked packaging dependencies require Node.js 22+, even though `vsce` itself declares Node.js 20+.

From the repository root:

```sh
cd firely-validation-vscode-extension
npm ci
npm test
npm run package
```

If you use nvm, run `nvm install` and `nvm use` inside `vscode-extension` first. To build from an older Node.js shell without changing its default installation:

```sh
cd firely-validation-vscode-extension
npx --yes --package=node@24 -- npm ci
npx --yes --package=node@24 -- npm run package
```

These commands download Node.js 24 into npm's cache. If dependencies are already installed, only the packaging command is needed. Dependency installation rejects unsupported Node.js versions, and packaging checks the version before loading `vsce` to avoid `ReferenceError: File is not defined` on Node.js 18.

The output is `fhir-ig-firely-validator-0.3.0.vsix`. The package ID remains `medcomdk.fhir-ig-firely-validator`; the display name is **MedCom Firely Validation**. The validation command and tool settings retain their `fhirIg` prefix. The old `fhirIg.showOutput` command and `fhirIg.maxParallelValidations` setting have been removed.

Install the package through **Extensions: Install from VSIX...** or:

```sh
code --install-extension fhir-ig-firely-validator-0.3.0.vsix
```

`.vscodeignore` excludes this development guide, tests, and build helpers from the extension package. Keep `README.md` focused on extension users.

## Debug and test

Open `firely-validation-vscode-extension` as the VS Code workspace, install dependencies, and press F5 to launch an Extension Development Host. Open an IG in that window and run **MedCom Firely Validation: Build and Validate**.

`npm test` runs the automated tests without requiring SUSHI or Firely. With both tools installed and package access available, run:

```sh
npm run test:integration
```

The integration test builds a temporary IG with a local profile and two instances. It verifies that Firely resolves the profile, accepts the valid instance, rejects an invariant violation, and retains the generated Firely manifest.

## Relationship to the publishing workflow

The extension follows `scripts/synchronize-sushi-and-firely.sh` and `scripts/validate-all-resources-with-firely.sh` in the repository root:

1. Read the package ID, version, description, FHIR version, and dependencies from SUSHI configuration. Map STU3, R4, R4B, or R5 to the release accepted by `fhir spec`.
2. Offer **Run SUSHI** (default checked) and **Delete output folder** (default unchecked) in one multi-select picker. Remove the guide-root `output` directory only when selected so Firely cannot discover stale publisher/genonce output.
3. If `package.json` is missing, create it with `fhir init <id> <version>`. Compare its dependency name/version pairs bidirectionally with the normalized `sushi-config.yaml` dependencies, ignoring `hl7.fhir.r*.core`. If they differ (or the manifest was just initialized), preserve the core dependency and all non-dependency fields, replace the remaining dependencies with the SUSHI dependencies, and run `fhir restore`. Matching dependency maps skip restore only when every package in the `fhirpkg.lock.json` closure appears in `fhir cache list`. Mute exit 255 only when its output identifies outdated circular dependencies; other restore failures still warn and remain eligible for retry.
4. Optionally run `sushi .`, according to the default-checked **Run SUSHI** picker. A requested build failure stops validation.
5. Launch validation for every Bundle in `fsh-generated/resources` concurrently, using the IG root as the working directory. Skip all other resource types. Firely needs project-relative file arguments to resolve the resources correctly. Display each Firely `Error`/`Fatal` as a separate Problem and map a supported `At:` path to the matching JSON node.

When Firely advertises `--fail` in command help, include it to make findings produce a failing exit code. Also recognize `Result: INVALID`, `Error:`, and `Fatal:` output: testing with Firely 3.5.0 showed that invalid resources can return exit code zero. See the [Firely command reference](https://docs.fire.ly/projects/Firely-Terminal/Command-Reference.html#fhir-validate).

All validation workers must finish before returning a result, including during cancellation or failure.

## Tool installation

Every validation starts a platform-native installer in a VS Code task terminal: `install-tools.sh` in Linux, WSL, and macOS extension hosts, or `install-tools.ps1` in a native Windows extension host. The installer checks for .NET SDK 8, Firely Terminal, npm, and SUSHI and installs only missing tools. On Unix-like hosts, command-line tools use the `~/.local` prefix while downloaded runtimes live under the user's local data directory:

- SUSHI: `npm install --global --prefix ~/.local --no-audit --no-fund fsh-sushi`
- Firely: `dotnet tool install Firely.Terminal --tool-path ~/.local/bin`

On Windows, the tools and downloaded runtimes live under `%LOCALAPPDATA%\medcom-firely-validation`; this avoids requiring Bash, WSL, administrator rights, or a system-wide installation.

The script verifies every tool before it exits and never uses sudo. The JavaScript waits for the task exit code, contributes the user tool paths to the extension environment, and then starts validation. The real integration test uses already installed tools.

## Publication

Packaging creates a local VSIX; it does not publish to the Marketplace. The `medcomdk` publisher identifier must be available to the publishing account before any Marketplace publication. No distribution license has been selected yet (`UNLICENSED`).
