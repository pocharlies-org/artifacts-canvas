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

{{/* Frame-route base URL: core.artifactBaseUrl, else the core's edge https://<publicHost>/<bucket>. */}}
{{- define "artifacts-canvas.artifactBaseUrl" -}}
{{- if .Values.core.artifactBaseUrl -}}
{{- .Values.core.artifactBaseUrl -}}
{{- else -}}
{{- printf "https://%s/%s" (required "core.publicHost is required (the artifacts host) unless core.artifactBaseUrl is set" .Values.core.publicHost) (include "artifacts-canvas.bucket" .) -}}
{{- end -}}
{{- end -}}

{{/* WebSocket origin allow-list: core.allowedOrigins, else https://<publicHost>. */}}
{{- define "artifacts-canvas.allowedOrigins" -}}
{{- if .Values.core.allowedOrigins -}}
{{- join "," .Values.core.allowedOrigins -}}
{{- else -}}
{{- printf "https://%s" (required "core.publicHost is required (the artifacts host) unless core.allowedOrigins is set" .Values.core.publicHost) -}}
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
