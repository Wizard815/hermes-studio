# Pin comments

Click a spot on a picture and write a comment. The comment goes to the open
chat as one message the agent can read:

```
Comment on 17-projects-marked-in-chats.png (pinned at 9% from the left, 25% from the top): test
```

## Where it works

- **Pictures in a chat.** Click a picture to open it, then **Comment**. While
  comment mode is on, a click pins a spot instead of closing the picture.
  **Send** (or Enter) posts the comment; Shift+Enter adds a line; Escape drops
  the pin. Sent pins stay on the picture as numbered marks, so you can add more.
- **The browser panel.** **Comment** in its toolbar switches the live view from
  clicking in the page to pinning comments on it. The comment names the page's
  address. Captured screenshots open in the same picture view, with Comment.
- The desktop browser's own element and region annotations still attach a
  screenshot with your note; pin comments send text only.

## What goes wrong

- **No Comment button:** no chat is open to take the comment. Open a chat
  first.
- **"The comment was not sent":** the chat could not take it (offline, or the
  run failed to start). The comment stays in the box; send it again.
- **The name says "this image":** the picture has no file name or alt text,
  for example a pasted screenshot.

## Code map

- `packages/client/src/utils/pin-comment.ts`: the message text, the spot as
  whole percentages, and the chat the comments go to (`ChatPanel.vue` sets it).
- `packages/client/src/components/common/PinComment.vue`: the pin layer and
  popover around a picture.
- Used in `ImagePreviewOverlay.vue` and `BrowserPanel.vue`.
- Tests: `tests/client/pin-comment.test.ts`, `tests/e2e/pin-comment.spec.ts`.
