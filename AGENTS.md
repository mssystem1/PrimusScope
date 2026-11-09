# Working efficiently on PrimusScope

The user has explicitly asked to reduce agent credit usage.

- Keep implementation in the primary agent by default. Delegate only a small,
  independent task when it is likely to reduce total work or catch a material
  issue. Avoid broad parallel research and duplicate reviews.
- Prefer one additional agent at a time. Give it a narrow file scope and only
  the context it needs; avoid full-history forks for routine work.
- Use a fast, affordable model for routine inspection, documentation and test
  execution when model selection is available. Reserve more expensive reasoning
  for concrete architectural or correctness problems.
- Reuse retained source evidence and prior test results. Repeat checks when
  changes, failures or an unresolved concern justify it.
- Keep progress updates and tool output concise. Finish the current useful
  slice before starting another workstream.

Do not reapply or publish managed environment settings as part of ordinary
development. The user manages publication. Never put credentials in source,
browser bundles, test artifacts or chat.
