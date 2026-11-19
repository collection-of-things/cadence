# Cadence agent instructions

Always use `portless` when running an app's development server.

For real Electron UI, playback/audio, restart, authenticated Apple Music checks,
or verification-helper changes, read
[verify-cadence](.agents/skills/verify-cadence/SKILL.md). It selects isolated flows,
prerequisites and evidence criteria. Keep the user's app/profile/audio untouched.

For coordinator, persisted-state or adapter event-handling changes, also read
[coordinator-tla-verify](.agents/skills/coordinator-tla-verify/SKILL.md).
