{{/*
Common names and labels for the artifacts-canvas chart.
*/}}
{{- define "artifacts-canvas.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "artifacts-canvas.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "artifacts-canvas.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "artifacts-canvas.labels" -}}
helm.sh/chart: {{ include "artifacts-canvas.chart" . }}
{{ include "artifacts-canvas.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: artifacts
{{- end -}}

{{- define "artifacts-canvas.selectorLabels" -}}
app.kubernetes.io/name: {{ include "artifacts-canvas.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "artifacts-canvas.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "artifacts-canvas.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* The artifacts bucket: core.bucket, else s3.bucket. */}}
{{- define "artifacts-canvas.bucket" -}}
{{- default .Values.s3.bucket .Values.core.bucket -}}
{{- end -}}

{{/*
core.publicHost, validated: required (no default) and never an example.* placeholder.
*/}}
{{- define "artifacts-canvas.publicHost" -}}
{{- $h := required "core.publicHost is required: the artifacts host (the core chart's artifactsHost)" .Values.core.publicHost -}}
{{- if regexMatch "(^|\\.)example\\.(com|net|org)$" (lower $h) -}}
{{- fail (printf "core.publicHost %q is an example placeholder: set the real artifacts host" $h) -}}
{{- end -}}
{{- $h -}}
{{- end -}}

{{/* Frame-route base URL: core.artifactBaseUrl, else the core's edge https://<publicHost>/<bucket>. */}}
{{- define "artifacts-canvas.artifactBaseUrl" -}}
{{- if .Values.core.artifactBaseUrl -}}
{{- .Values.core.artifactBaseUrl -}}
{{- else -}}
{{- printf "https://%s/%s" (include "artifacts-canvas.publicHost" .) (include "artifacts-canvas.bucket" .) -}}
{{- end -}}
{{- end -}}

{{/* WebSocket origin allow-list: core.allowedOrigins, else https://<publicHost>. */}}
{{- define "artifacts-canvas.allowedOrigins" -}}
{{- if .Values.core.allowedOrigins -}}
{{- join "," .Values.core.allowedOrigins -}}
{{- else -}}
{{- printf "https://%s" (include "artifacts-canvas.publicHost" .) -}}
{{- end -}}
{{- end -}}

{{/* Digest-pinned image reference: repository@digest when digest is set, else repository:tag. */}}
{{- define "artifacts-canvas.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}
{{- end -}}

{{/* Bytes of a Kubernetes memory quantity (a number, or one with k, M, G, T, Ki, Mi, Gi, Ti). */}}
{{- define "artifacts-canvas.quantityBytes" -}}
{{- if or (kindIs "float64" .) (kindIs "int" .) (kindIs "int64" .) -}}
{{- float64 . -}}
{{- else -}}
{{- $q := toString . -}}
{{- $num := regexFind "^[0-9]+(\\.[0-9]+)?" $q -}}
{{- $unit := trimPrefix $num $q -}}
{{- $mult := dict "" 1 "k" 1000 "M" 1000000 "G" 1000000000 "T" 1000000000000 "Ki" 1024 "Mi" 1048576 "Gi" 1073741824 "Ti" 1099511627776 -}}
{{- if or (not $num) (not (hasKey $mult $unit)) -}}
{{- fail (printf "resources.limits.memory %q: use a number, optionally with k, M, G, T, Ki, Mi, Gi or Ti" $q) -}}
{{- end -}}
{{- mulf (float64 $num) (float64 (get $mult $unit)) -}}
{{- end -}}
{{- end -}}

{{/*
The memory limit must hold what the process can (values.yaml, "Memory"): the loaded rooms and one
worker's message headroom from the budget heapLimitMb leaves, the runtime, the outgoing budget and
the messages in flight, plus 64 MiB. Without a memory limit there is nothing to check.
*/}}
{{- define "artifacts-canvas.validateMemory" -}}
{{- if not (gt (float64 .Values.heapLimitMb) 0.0) -}}
{{- fail "heapLimitMb must be a positive number of MiB (the heap the room budget is derived from)" -}}
{{- end -}}
{{- $lim := dig "limits" "memory" "" (.Values.resources | default dict) -}}
{{- if $lim -}}
{{- $mem := divf (float64 (include "artifacts-canvas.quantityBytes" $lim)) 1048576.0 -}}
{{- $h := float64 .Values.heapLimitMb -}}
{{- $s := float64 .Values.limits.roomMemoryPrincipalShare -}}
{{- $out := divf (float64 .Values.limits.wsOutgoingBudgetBytes) 1048576.0 -}}
{{- $in := divf (float64 .Values.worker.inflightBytes) 1048576.0 -}}
{{- $need := addf (mulf (addf 0.85 $s) $h) (mulf (subf 0.15 $s) (addf 192.0 $out)) $in 64.0 -}}
{{- if lt $mem $need -}}
{{- fail (printf "resources.limits.memory (%.0f MiB) is too small for heapLimitMb %v: the process can hold up to %.0f MiB with these values (values.yaml, \"Memory\"); raise the memory limit or lower heapLimitMb" $mem .Values.heapLimitMb $need) -}}
{{- end -}}
{{- end -}}
{{- end -}}
