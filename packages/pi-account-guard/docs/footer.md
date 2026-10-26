# Footer

The footer item `guard` is always on. It shows the place zone and the Match state:

| Text | Meaning |
|---|---|
| `guard personal ✓` | The account matches the place zone. |
| `guard personal ✗ acme is work` | No Match. The next turn is blocked. |
| `guard personal ? untagged` | The account has no tag. |
| `guard OVERRIDE acme in personal` | An Allow for session is active. |
| `guard ! config invalid (last valid copy in use)` | The file is malformed and a valid earlier copy is in use. |
| `guard ! config invalid, turns blocked` | The file is malformed and no valid copy exists. |
| `guard ! zone unknown (git failed)` | A remote rule matters and git failed. |

## pi-powerline-footer

Powerline shows the guard text in its extension statuses segment as it is. To give it a place of its own, which also takes it out of that segment, add `{ "id": "guard", "statusKey": "guard", "position": "left" }` to `powerline.customItems`.
