# Changelog

## 0.2.3 — 2026-11-02

Heart 0.20.2 adds local runtime evidence that automatically resumes on plugin load. Bounded sample and fatal-event files are independent of the 500-line pulse window. Fatal exceptions retain their normal nonzero exit behavior; no host restart, shell watchdog, model invocation or outgoing message is added. Five new regression tests cover real child-process failure, reload cleanup, rotation, privacy and write failures.

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
