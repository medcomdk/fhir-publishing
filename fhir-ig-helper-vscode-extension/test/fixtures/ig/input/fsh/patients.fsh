Invariant: patient-has-name
Description: "The patient must have a name."
Severity: #error
Expression: "name.exists()"

Profile: NamedPatient
Parent: Patient
Id: named-patient
* obeys patient-has-name

Instance: patient-valid
InstanceOf: NamedPatient
Usage: #example
* name.family = "Example"

Instance: patient-invalid
InstanceOf: NamedPatient
Usage: #example
* active = true

Instance: bundle-valid
InstanceOf: Bundle
Usage: #example
* type = #collection
* entry[0].resource = patient-valid

Instance: bundle-invalid
InstanceOf: Bundle
Usage: #example
* type = #collection
* entry[0].resource = patient-invalid
