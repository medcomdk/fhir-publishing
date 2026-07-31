#!/usr/bin/env bash

is_conformance_resource() {
    case "$1" in
        StructureDefinition|\
        ValueSet|\
        CodeSystem|\
        ConceptMap|\
        SearchParameter|\
        OperationDefinition|\
        CapabilityStatement|\
        ImplementationGuide|\
        MessageDefinition|\
        StructureMap|\
        NamingSystem|\
        CompartmentDefinition|\
        GraphDefinition|\
        ExampleScenario|\
        TerminologyCapabilities|\
        TestScript)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

# Terminal formatting
RED=$'\033[1;31m'
GREEN=$'\033[1;32m'
YELLOW=$'\033[1;33m'
RESET=$'\033[0m'

validated=0
skipped=0
failed=0
passed=0
failed_count=0

declare -a validation_pids
declare -A validation_files
declare -A validation_logs

log_directory=$(mktemp -d)

cleanup() {
    rm -rf "$log_directory"
}

trap cleanup EXIT

while IFS= read -r -d '' file; do
    resource_type=$(jq -r '.resourceType // empty' "$file")

    if [[ -z "$resource_type" ]]; then
        printf '%sSkipping %s: no resourceType found.%s\n' \
            "$YELLOW" "$(basename "$file")" "$RESET"

        skipped=$((skipped + 1))
        continue
    fi

    if is_conformance_resource "$resource_type"; then
        printf '%sSkipping %s: %s%s\n' \
            "$YELLOW" "$(basename "$file")" "$resource_type" "$RESET"

        skipped=$((skipped + 1))
        continue
    fi

    echo "Starting validation of $(basename "$file") ($resource_type)..."

    log_file="$log_directory/validation-$validated.log"

    # Capture stdout and stderr separately for each parallel process.
    fhir validate "$file" >"$log_file" 2>&1 &

    pid=$!

    validation_pids+=("$pid")
    validation_files["$pid"]="$file"
    validation_logs["$pid"]="$log_file"

    validated=$((validated + 1))
done < <(
    find fsh-generated/resources \
        -maxdepth 1 \
        -type f \
        -name '*.json' \
        -print0
)

echo
echo "Started $validated validations. Waiting for them to finish..."
echo

declare -a failed_pids

for pid in "${validation_pids[@]}"; do
    file="${validation_files[$pid]}"

    if wait "$pid"; then
        passed=$((passed + 1))
    else
        failed_pids+=("$pid")
        failed_count=$((failed_count + 1))
        failed=1
    fi
done

if [[ "$failed_count" -gt 0 ]]; then
    echo
    printf '%s================ VALIDATION ERRORS ================%s\n' \
        "$RED" "$RESET"

    for pid in "${failed_pids[@]}"; do
        file="${validation_files[$pid]}"
        log_file="${validation_logs[$pid]}"

        echo
        printf '%sFile with validation errors:%s\n' "$RED" "$RESET"
        printf '%s%s%s\n' "$RED" "$file" "$RESET"
        printf '%s---------------------------------------------------%s\n' \
            "$RED" "$RESET"

        cat "$log_file"

        printf '%s---------------------------------------------------%s\n' \
            "$RED" "$RESET"
    done
fi

echo
echo "Validation completed."
echo "Validated: $validated"
printf 'Passed:    %s%d%s\n' "$GREEN" "$passed" "$RESET"
printf 'Failed:    %s%d%s\n' "$RED" "$failed_count" "$RESET"
echo "Skipped:   $skipped"

if [[ "$failed" -ne 0 ]]; then
    echo
    printf '%sOne or more instances failed validation.%s\n' \
        "$RED" "$RESET"
    exit 1
fi

printf '%sAll instances passed Firely (.NET) validation.%s\n' \
    "$GREEN" "$RESET"