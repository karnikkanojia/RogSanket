# EpiCast data processing

Updated October 18, 2026.

EpiCast is a research surveillance prototype. Generated text is a draft requiring
qualified review. This repository does not establish clinical effectiveness.

The SwiftUI app sends narratives and selected media to the local Swift service.
Connection Settings accepts only localhost addresses, so its inputs stay on the
same Mac. Inference runs in a separate local worker. This application does not
claim UI-side or phone-side model inference.

The Swift server stores structured signals, district/facility, encounter time,
model provenance, report jobs, and cached draft reports in SQLite. Raw narratives,
patient coordinates, audio, and images are not persisted by this service.
Temporary image files created by the experimental Swift worker are removed after
the task. Crashes may require operator cleanup of OS temporary storage. An
exclusive writer lease prevents concurrent Swift server instances from writing
the same database simultaneously. Inputs remain in process memory while requests execute. Client-selected originals remain
under the user's control.

SQLite is not encrypted by the application. Use OS disk encryption and restricted
filesystem access. No Supabase synchronization or database encryption is claimed.
No analytics or advertising integrations are implemented in the canonical API.

Remote 27B reporting is disabled by default. An operator may configure a remote
chat-completions endpoint. Only district-level aggregate statistics, alert evidence,
and date are sent. Narratives, media, identifiers, facility names, and precise
coordinates are excluded from the report request. Operators must assess their
chosen provider's retention and transport policies; this repository cannot
promise that external services retain nothing. Disable the remote endpoint to
retain local reporting. Do not put patient identifiers in district names.

Model provisioning is explicit and may contact Hugging Face after acceptance of
model terms. Runtime workers use local paths and offline flags. Artifact checksum
and parity gates must pass before model execution. No application startup downloads
model weights automatically.

The default API binds to localhost. Exposing it to a network requires deployment
access controls and TLS. The SwiftUI development app imports media and supports camera/microphone capture
with OS permission. Its local app bundle is ad-hoc signed, not notarized. Captured
media is temporary; inspect OS temporary storage after crashes.

Delete the local SQLite database and its WAL/SHM files while the service is stopped
to remove locally stored records. Backups and any configured remote infrastructure
must be managed separately. No unsupported deletion-service promise is made.
