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

If you use nvm, run `nvm install` and `nvm use` inside `firely-validation-vscode-extension` first. To build from an older Node.js shell without changing its default installation:

```sh
cd firely-validation-vscode-extension
npx --yes --package=node@24 -- npm ci
npx --yes --package=node@24 -- npm run package
```

These commands download Node.js 24 into npm's cache. If dependencies are already installed, only the packaging command is needed. Dependency installation rejects unsupported Node.js versions, and packaging checks the version before loading `vsce` to avoid `ReferenceError: File is not defined` on Node.js 18.

The output is `fhir-ig-firely-validator-1.0.2.vsix`. The package ID remains `MedComPublisher.fhir-ig-firely-validator`; the display name is **MedCom Firely Validation**. The validation command and tool settings retain their `fhirIg` prefix. The old `fhirIg.showOutput` command and `fhirIg.maxParallelValidations` setting have been removed.

Install the package through **Extensions: Install from VSIX...** or:

```sh
code --install-extension fhir-ig-firely-validator-1.0.2.vsix
```

`.vscodeignore` excludes this development guide, tests, and build helpers from the extension package. Keep `README.md` focused on extension users.

## Debug and test

Open `firely-validation-vscode-extension` as the VS Code workspace, install dependencies, and press F5 to launch an Extension Development Host. Open an IG in that window and run **MedCom Firely Validation: Build and Validate**.

`npm test` runs the automated tests without requiring SUSHI or .NET. With .NET SDK 8 or newer, a .NET 8 runtime, and package access available, run:

```sh
npm run test:integration
```

The integration test creates a local package with a profile invariant, validates nested Bundle resources through the extension, and exercises the package-only CLI used by CI. It checks valid and invalid instances, malformed JSON/XML, required narratives, unknown profiles, unsupported FHIR versions, and missing/corrupt packages. It verifies that SDK validation selects published JSON and XML Bundles instead of raw SUSHI output.

## Shared SDK validator

`validator/FirelyValidator.csproj` is a .NET 8 console app shared by the extension and `.github/workflows/publish.yaml`. Its source is included in the VSIX; `bin` and `obj` are excluded. The extension builds/runs it using `dotnet run`. It uses pinned Firely R4 NuGet packages, one cached package resolver, and sequential validation with a reusable validator. See [Firely's package source documentation](https://docs.fire.ly/projects/Firely-NET-SDK/en/latest/resource-resolving/fhirpackagesource.html).

The CLI validates instance JSON from `package/` and `package/example/`, skipping conformance resources and package metadata. It checks the manifest for R4. Local definitions are read directly from the archive into an in-memory resolver; `FhirPackageSource` resolves the manifest's dependencies. This avoids Firely reusing an older cached IG with the same package ID/version. `--resources` instead selects a directory of instance JSON/XML (XML DTD processing is prohibited), `--resource-type Bundle` limits validation to Bundles, and `--report` writes JSON results. It returns 0 when there are no errors, 1 for resource failures, and 2 for setup/input failures. Warning-only runs pass; no validated instances produces an explicit warning.

The existing `fhirIg.validate` command keeps its quick Terminal workflow, including its SUSHI and output-deletion options. The separate `fhirIg.validateSdk` command offers **Run _genonce.sh** (default checked). It uses the workspace folder containing the selected configuration as the working directory and runs `bash ./_genonce.sh`. Before a requested rebuild, it removes the old `output/package.tgz` and requires the script to create a new archive. If the option is cleared, it preserves and requires the existing archive without checking for a script or build tools. A missing archive is reported before tool setup with the expected path and rebuild instructions. The script owns Java/Publisher configuration. Quick Terminal validation reads `fsh-generated/resources`. SDK validation reads `output/Bundle-*.json` and `output/Bundle-*.xml` so it includes Publisher narratives; HTML wrappers and other output files are excluded. Both serializations are validated and counted separately. Missing published Bundles are an error. The SDK path performs no Terminal commands or manifest mutations. A single SDK process produces a structured report; cancellation waits for it to stop and removes the temporary report. Problems use SDK error paths to locate JSON nodes; XML diagnostics attach to the file and retain the resource path in their messages.

CI retains the initial Terminal check and runs SDK validation immediately after Publisher builds `output/package.tgz` in the `prepare` job. Both checks honor `ALLOW_VALIDATION_FAILURE` and report overridden failures. The SDK validates the unmodified packaged profiles, without the Danish Core FHIRPath rewrites from the demo.

## Tool installation

Every validation starts `install-tools.sh` (Linux, WSL, macOS) or `install-tools.ps1` (Windows) in a VS Code task terminal. These check .NET SDK 8, npm, and SUSHI and install missing tools without sudo. Quick validation also checks/installs Firely Terminal. The SDK command passes `--sdk-only` / `-SdkOnly` to skip Terminal. Unix tools use `~/.local`; downloaded runtimes use the user's local data directory. Windows tools live under `%LOCALAPPDATA%\medcom-firely-validation`.

## Publication

Packaging creates a local VSIX; it does not publish to the Marketplace. The `MedComPublisher` publisher identifier must be available to the publishing account before any Marketplace publication. No distribution license has been selected yet (`UNLICENSED`).

## Faster narrative generation

Publisher documents [`-validation-off`](https://github.com/HL7/fhir-ig-publisher/blob/master/documentation.md) for skipping its validation while retaining narrative generation. For a root `_genonce.sh` that forwards arguments, `./_genonce.sh -validation-off` reduces build work before SDK validation. This still performs publication work; it is not a narrative-only build. The extension runs the script without extra arguments. `-generation-off` is unsuitable because it disables narrative generation too.

A standalone narrative generator is technically possible using HL7’s Java rendering library. [`ValidationEngine.generate` and `genResource`](https://github.com/hapifhir/org.hl7.fhir.core/blob/master/org.hl7.fhir.validation/src/main/java/org/hl7/fhir/validation/ValidationEngine.java) expose rendering and recurse through Bundle entries. These are a starting point, not a drop-in equivalent of Publisher: the wrapper must load the guide’s profiles and dependencies, configure rendering and reference resolution, preserve R4 serialization, and match Publisher’s handling of existing narratives and templates. Its results need comparison against real Publisher output before replacing the build.

No standalone rendering mode is implemented here. Reusing `output` is the available fast SDK path, and requires a rebuild when inputs change. Adding placeholder narratives or ignoring the `text` constraint would hide real failures and is not equivalent to generating Publisher narratives.
