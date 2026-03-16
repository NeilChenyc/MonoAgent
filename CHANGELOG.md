# Changelog

All notable changes to MonoAgent will be documented in this file.

## [1.2.0](https://github.com/qwibitai/monoagent/compare/v1.1.6...v1.2.0)

[BREAKING] WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add (existing auth/groups preserved).
- **fix:** Prevent scheduled tasks from executing twice when container runtime exceeds poll interval (#138, #669)
