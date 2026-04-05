---
name: profile
description: View your personality profile or trigger a rebuild.
  "/mnemo:profile" shows current profile.
  "/mnemo:profile rebuild" triggers a fresh synthesis.
---

# Profile

If "rebuild" is in the command:
1. Read all profile facts with `mnemo_profile`
2. Read recent episodes with `mnemo_episodes` (limit 30)
3. Read entities with `mnemo_search_entities` (query "*", limit 20)
4. Synthesize a new personality document covering: identity, work style,
   current projects, preferences, key people, recent context
5. Save with `mnemo_remember` (category="_system", key="profile_document")

Otherwise:
1. Call `mnemo_profile` with no category to get the personality document
2. Display it to the user
