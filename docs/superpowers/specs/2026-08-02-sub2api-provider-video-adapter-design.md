# Sub2API Provider Video Adapter Design

## Goal

Adapt the managed Sub2API video channel to the current OpenAI Video and xAI Video contracts without changing the generic video integrations used by other channels.

## Provider Binding

Add a stable `providerId` to `ModelChannel` and resolved model request config. The managed OIDC channel receives `providerId: "sub2api"` from the server configuration. It is an internal identifier and is not displayed to users. Do not infer it from channel name, model name, base URL, or the configurable OIDC provider display name.

`apiFormat` continues to select the inbound protocol. For a Sub2API model, `openai` selects the OpenAI Video adapter and `xai` selects the xAI Video adapter.

## Adapter Boundary

Keep the current generic `createOpenAIVideoTask`, `pollOpenAIVideoTask`, `createXaiVideoTask`, and `pollXaiVideoTask` unchanged. Add a dedicated Sub2API video module containing create and poll functions for both formats. The shared video service only dispatches to that module when `providerId` is `sub2api`.

Persist `adapter: "sub2api"` on created video tasks. Polling uses this stored adapter rather than current channel settings so an existing task retains its protocol behavior after configuration changes or page refresh.

## Sub2API OpenAI Video

Create requests use JSON at `/v1/videos` with `model`, `prompt`, positive `seconds`, explicit `size`, optional `preset`, and JSON `input_reference` entries using image data URLs. No multipart form body, `resolution_name`, or seven-reference cap is sent.

Completed tasks use `video.url` when present and download it without gateway credentials. If it is unavailable, the adapter requests `/v1/videos/{id}/content`. The downloaded bytes are stored in the existing browser media storage; signed URLs are not persisted as final asset URLs.

## Sub2API xAI Video

Create requests use JSON at `/v1/videos/generations` with `model`, `prompt`, `duration`, `aspect_ratio`, `resolution`, optional `preset`, and `image` or `reference_images`. Duration remains limited to 1-15 seconds. Video and audio references remain unsupported by this UI.

Status and content are read using the xAI task shape. `done` is terminal success; `failed` and `expired` are terminal failure.

## Error Handling and Verification

The Sub2API adapter does not retry uncertain creation requests or fall back to another request encoding. It preserves the existing polling loop, with Sub2API-specific handling for completed private-media URLs and documented task statuses.

Add focused unit tests for provider dispatch, OpenAI JSON payloads, xAI `reference_images` payloads, persisted task adapter selection, and completed task download behavior. Update the pending-test and changelog records when implementation is complete.
