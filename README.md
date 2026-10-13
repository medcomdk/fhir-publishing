# fhir-publishing

Publishing helpers and workflows for FHIR implementation guides.

For local development, the [MedCom Firely Validation VS Code extension](firely-validation-vscode-extension/README.md)
offers quick Firely Terminal validation and Firely .NET SDK validation of published R4 JSON/XML Bundles in `output`, with an optional `_genonce.sh` rebuild.

Extension contributors can find build, test, and packaging instructions in the
[extension development guide](firely-validation-vscode-extension/DEVELOPMENT.md).

The publish workflow also validates packaged instances with the shared SDK validator after
IG Publisher creates `output/package.tgz`, before publication. Errors stop the workflow unless
`ALLOW_VALIDATION_FAILURE` is enabled.

To validate a built package locally (.NET SDK 8 or newer and .NET 8 runtime):

```sh
dotnet run --project firely-validation-vscode-extension/validator --configuration Release -- /path/to/output/package.tgz
```

This validates instances in the package using its profiles and dependencies, with local,
MIME-type, and external terminology services. R4 (4.0.x) is supported. Warnings do not fail
the run; parse errors, missing profiles, and validation errors do.
