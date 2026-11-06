using System.Formats.Tar;
using System.IO.Compression;
using System.Text.Json;
using System.Xml;
using Firely.Fhir.Packages;
using Firely.Fhir.Validation;
using Hl7.Fhir.Model;
using Hl7.Fhir.Rest;
using Hl7.Fhir.Serialization;
using Hl7.Fhir.Specification.Source;
using Hl7.Fhir.Specification.Terminology;

return await Run(args);

static async Task<int> Run(string[] args)
{
    if (args.Length == 0 || args.Length % 2 != 1)
    {
        Console.Error.WriteLine("Usage: FirelyValidator package.tgz [--resources directory] [--report file.json] [--resource-type Bundle] [--terminology-server https://tx.hl7europe.eu/r4]");
        return 2;
    }

    try
    {
        var options = new Dictionary<string, string>();
        for (var i = 1; i < args.Length; i += 2)
        {
            if (args[i] is not ("--resources" or "--report" or "--resource-type" or "--terminology-server"))
                throw new ArgumentException($"Unknown option: {args[i]}");
            options.Add(args[i], args[i + 1]);
        }

        var packagePath = Path.GetFullPath(args[0]);
        var package = ReadPackage(packagePath);
        var files = options.TryGetValue("--resources", out var directory)
            ? Directory.GetFiles(directory).Where(file =>
                (Path.GetExtension(file).Equals(".json", StringComparison.OrdinalIgnoreCase) ||
                 Path.GetExtension(file).Equals(".xml", StringComparison.OrdinalIgnoreCase)) &&
                (!options.TryGetValue("--resource-type", out var selectedType) ||
                 Path.GetFileName(file).StartsWith(selectedType + "-", StringComparison.OrdinalIgnoreCase)))
                .Order().Select(file => new Input(file, File.ReadAllText(file))).ToList()
            : package.Files;
        if (files.Count == 0)
            throw new InvalidDataException("No matching resource JSON or XML files were found to validate.");

        Console.WriteLine($"Resolving profiles and dependencies from {packagePath}");
        // Loading a local .tgz through FhirPackageSource reuses an installed package
        // with the same id/version. Read this build's definitions directly instead;
        // use the package source only for the dependencies in this build's manifest.
        var definitions = package.Files
            .Where(file => !file.Name[8..].Contains('/'))
            .Select(file => FhirJsonDeserializer.DEFAULT.DeserializeResource(file.Json))
            .Where(resource => IsConformanceResource(resource.TypeName));
        var local = new InMemoryResourceResolver(definitions);
        var dependencies = new FhirPackageSource(ModelInfo.ModelInspector,
            "https://packages.simplifier.net", package.Dependencies);
        var resolver = new CachedResolver(new MultiResolver(local, dependencies));
        using var client = new FhirClient(options.GetValueOrDefault("--terminology-server", "https://tx.hl7europe.eu/r4"));
        var terminology = new MultiTerminologyService(
            new LocalTerminologyService(resolver),
            new MimeTypeTerminologyService(),
            new ExternalTerminologyService(client));
        var validator = new Validator(resolver, terminology);
        var results = new List<Result>();

        // Reuse the resolver and validator caches, sequentially: they are not thread-safe.
        foreach (var file in files)
        {
            Result result;
            try
            {
                var resource = DeserializeInput(file);
                var type = resource.TypeName;
                if (IsConformanceResource(type) ||
                    (options.TryGetValue("--resource-type", out var selectedType) && type != selectedType))
                {
                    results.Add(new Result(file.Name, "skipped", 0, 0, $"Skipped {type}."));
                    continue;
                }

                Console.WriteLine($"Validating {file.Name}...");
                var outcome = validator.Validate(resource);
                var output = string.Join(Environment.NewLine, outcome.Issue.Select(issue =>
                    $"{issue.Severity}: {issue.Details?.Text ?? issue.Diagnostics ?? issue.Code?.ToString()}" +
                    $" [{string.Join(", ", issue.Details?.Coding.Select(c => c.Code) ?? [])}]" +
                    (issue.Expression.Any() ? $"\nAt: {issue.Expression.First()}" : "")));
                result = new Result(file.Name, outcome.Errors > 0 ? "failed" : "passed",
                    outcome.Errors, outcome.Warnings, output);
            }
            catch (Exception exception)
            {
                result = new Result(file.Name, "failed", 1, 0, $"Error: {exception.Message}");
            }
            results.Add(result);
            Console.WriteLine($"{result.Status.ToUpperInvariant()} {file.Name}: {result.Errors} errors, {result.Warnings} warnings\n{result.Output}");
        }

        var passed = results.Count(r => r.Status == "passed");
        var failed = results.Count(r => r.Status == "failed");
        var skipped = results.Count(r => r.Status == "skipped");
        var warnings = new List<string>();
        if (passed + failed == 0) warnings.Add("No instances were validated; all resources were skipped.");
        var warningCount = results.Sum(r => r.Warnings);
        if (warningCount > 0) warnings.Add($"Validation reported {warningCount} warnings. See the validation output.");
        var summary = new { validated = passed + failed, passed, failed, skipped, warnings, results };
        Console.WriteLine($"Validated: {passed + failed}; Passed: {passed}; Failed: {failed}; Skipped: {skipped}");
        foreach (var warning in warnings) Console.WriteLine($"Warning: {warning}");
        if (options.TryGetValue("--report", out var report))
            await File.WriteAllTextAsync(report, JsonSerializer.Serialize(summary,
                new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true }));
        return failed > 0 ? 1 : 0;
    }
    catch (Exception exception)
    {
        Console.Error.WriteLine($"Validation could not complete: {exception.Message}");
        return 2;
    }
}

static Resource DeserializeInput(Input file)
{
    if (!Path.GetExtension(file.Name).Equals(".xml", StringComparison.OrdinalIgnoreCase))
        return FhirJsonDeserializer.DEFAULT.DeserializeResource(file.Json);
    using var text = new StringReader(file.Json);
    using var reader = XmlReader.Create(text, new XmlReaderSettings
    {
        DtdProcessing = DtdProcessing.Prohibit,
        XmlResolver = null
    });
    return FhirXmlDeserializer.DEFAULT.DeserializeResource(reader);
}

static Package ReadPackage(string packagePath)
{
    using var stream = File.OpenRead(packagePath);
    using var gzip = new GZipStream(stream, CompressionMode.Decompress);
    using var tar = new TarReader(gzip);
    var files = new List<Input>();
    string? manifest = null;
    while (tar.GetNextEntry() is { } entry)
    {
        var name = entry.Name.StartsWith("./") ? entry.Name[2..] : entry.Name;
        if (entry.EntryType is not (TarEntryType.RegularFile or TarEntryType.V7RegularFile) ||
            entry.DataStream is null || !name.StartsWith("package/") || !name.EndsWith(".json")) continue;
        using var reader = new StreamReader(entry.DataStream, leaveOpen: true);
        if (name == "package/package.json") manifest = reader.ReadToEnd();
        else if (!Path.GetFileName(name).StartsWith('.') &&
                 (name.StartsWith("package/example/") || !name[8..].Contains('/')))
            files.Add(new Input(name, reader.ReadToEnd()));
    }
    if (manifest is null) throw new InvalidDataException("The archive has no package/package.json.");
    using var metadata = JsonDocument.Parse(manifest);
    if (!metadata.RootElement.TryGetProperty("fhirVersions", out var versions) ||
        versions.ValueKind != JsonValueKind.Array || versions.GetArrayLength() != 1 ||
        versions[0].GetString()?.StartsWith("4.0.") != true)
        throw new InvalidDataException("The SDK validator supports FHIR R4 (4.0.x) packages only.");
    var dependencies = metadata.RootElement.TryGetProperty("dependencies", out var declared)
        ? declared.EnumerateObject().Select(dependency => $"{dependency.Name}@{dependency.Value.GetString()}").ToArray()
        : [];
    if (!dependencies.Any(dependency => dependency.StartsWith("hl7.fhir.r4.core@")))
        dependencies = ["hl7.fhir.r4.core@4.0.1", ..dependencies];
    return new Package(files.OrderBy(file => file.Name).ToList(), dependencies);
}

static bool IsConformanceResource(string type) => type is
    "ActorDefinition" or "StructureDefinition" or "ValueSet" or "CodeSystem" or "ConceptMap" or
    "SearchParameter" or "OperationDefinition" or "CapabilityStatement" or "ImplementationGuide" or
    "MessageDefinition" or "StructureMap" or "NamingSystem" or "CompartmentDefinition" or
    "GraphDefinition" or "ExampleScenario" or "TerminologyCapabilities" or "TestScript";

record Input(string Name, string Json);
record Package(List<Input> Files, string[] Dependencies);
record Result(string File, string Status, int Errors, int Warnings, string Output);
