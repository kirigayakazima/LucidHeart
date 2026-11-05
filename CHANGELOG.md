# Changelog

## 0.3.2 candidate — 2026-11-04

Combined Heart0.21.1 schema hotfix, RVC0.2.4 pause-aware long speech, and FullAwake adapter/PC gateway0.2.1. Whole-utterance TTS is retained; continuous speech is partitioned at pauses (low-energy fallback), converted with shared sessions and merged on the original timeline. Keeps the per-forward1000-frame guard, existing assets and quota policy. Audio return cap8MiB / streamed JSON12MiB; PC/client timeouts290/300s. Node203, audio Python20, gateway11 tests pass. Real CPU baseline6.6s WAV is unchanged;20.6s dry speech produces a complete40kHz output. Native mobile preview/install and listening acceptance remain pending; no automatic phone push or production restart.

## 0.3.1 candidate — 2026-11-04

Heart0.21.1 fixes heart_next returning origin/categoryQuotaRecorded under a message-only closed output schema. The new regression first reproduces the real host validator failure, then covers user-request/autonomous/unknown/cap-denied/default tool outputs through @deepseek-ai/dsh-tools validateJsonSchemaValue. Strict additionalProperties:false remains; no quota reset, scheduler change, persona write or memory merge. Full Heart suite:180 tests pass. Phone installation/acceptance remains pending; this is a Heart-only patch with0.21.0 rollback.

## Unreleased — 2026-11-04

Conversation candidate 0.3.0: Heart0.21.0 adds a bounded, switchable expression policy; QQPlus0.3.0 fixes optional Heart lookup and adds cancellable ordered semantic bubbles / explicit native streaming; QQBot0.5.7 carries turn cancellation and stream versions through actual output routing; Memory0.1.1 closes model-facing scope/detail gaps; RVC0.2.3 suppresses cancelled audio delivery and replaces singing/dev fake success with explicit failure. No phone deployment, persona write, memory merge, model change or voice asset change has occurred. Installation uses build190 native previews and reviewed fingerprints with original offline rollback packages.

Add `tools/memory-shape` 0.1.0: a standalone read-only exporter, local JSON viewer, private single-file renderer and explainable shadow scoring policy. Explicitly select the active Memory directory; keep Heart history, Dream candidates and other archives separate. No plugin lifecycle, production ranking, memory mutation or background job is changed. Twelve Node regressions pass. Real phone export yields 95 nodes without read warnings; real-browser visual acceptance remains pending.

## 0.2.3 — 2026-11-02

Heart 0.20.2 adds local runtime evidence that automatically resumes on plugin load. Bounded sample and fatal-event files are independent of the 500-line pulse window. Fatal exceptions retain their normal nonzero exit behavior; no host restart, shell watchdog, model invocation or outgoing message is added. Five new regression tests cover real child-process failure, reload cleanup, rotation, privacy and write failures.

Phone acceptance confirmed repeated samples at approximately 60-second intervals under the same host PID after loading 0.20.2. This establishes sampler operation, not long-term host stability or the cause of earlier disconnects.

Android bridge authentication was separately repaired on the user's device by restoring two legacy L2S credential aliases to independent native files. This manual device repair is not a plugin feature or background repair task. The device accepted authenticated requests afterward while continuing to reject unauthenticated requests.

## 0.2.2 — 2026-11-02

Components: Heart 0.20.1, RVC 0.2.2, FullAwake adapter/PC gateway 0.2.0.

- Restore optional Cordis service lookup for voice delivery, Heart observations and PC delegation. Report actual delivery/offload results rather than silently dropping service errors.
- Add opt-in, authenticated PC ONNX CPU voice compute and bounded audio return. Match the phone's voice assets and settings; validate returned audio before saving locally. Fall back to the same phone profile when PC compute is unavailable.
- Add a USB reverse connection helper and a hidden PC gateway launcher. Voice compute remains disabled unless explicitly enabled; no firewall changes or automatic startup tasks.
- Separate autonomous activity quotas from responses to user messages using host session provenance. Keep autonomous limits and existing quiet-hours/mood gates; never reset the autonomous ledger to make a user task pass.
- Pin the Bili sovereign fork to 2.4.0-heart.2, which contains child-process callback exception isolation and optional Heart service lookup.

Validation: 189 Heart/RVC/FullAwake JavaScript tests, 3 targeted PC voice tests. Real phone acceptance of PC synthesis, QQ voice delivery and Heart observation succeeded on RVC 0.2.1. After installing Heart 0.20.1 and RVC 0.2.2, the user confirmed a further voice message was delivered with `activity_gate.origin: user_request` and `quotaApplied: false`. Counter preservation and autonomous denials are covered by regression tests.

Current PC offload reports `pc_onnx_offload` and `CPUExecutionProvider`. GPU acceleration is not part of this release. Voice weights remain external to all source and npm packages.
