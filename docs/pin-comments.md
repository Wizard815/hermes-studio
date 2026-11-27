# Pin comments

Click a spot on a picture and write a comment. The comment goes to the open
chat as one message the agent can read:

```
Comment on 17-projects-marked-in-chats.png (pinned at 9% from the left, 25% from the top): test
```

## What the model gets

The one-line comment is what shows in the chat. With it go:

- **The picture with the pin drawn on it** (a red circle with the pin's
  number), and **a close-up** around the pin, as image attachments, so a model
  that reads images sees exactly what you pinned.
- **Where, in words and pixels**, on the first picture's collapsed context:
  "Pin 1 on shot.png: upper left, 9% from the left and 25% from the top. That
  is pixel 113 × 314 of a 1254 × 1254 picture."
- **On a web page, what is there**: the element under the pin, read from the
  page (tag, label or text, role, a CSS selector, its link).

If the picture can't be copied (it is from another site), no pictures go, and
the where-and-what lines are added to the message text instead.

## Where it works

- **Pictures in a chat.** Click a picture to open it, then **Comment**. While
  comment mode is on, a click pins a spot instead of closing the picture.
  **Send** (or Enter) posts the comment; Shift+Enter adds a line; Escape drops
  the pin. Sent pins stay on the picture as numbered marks, so you can add more.
- **The browser panel.** **Comment** in its toolbar switches the live view from
  clicking in the page to pinning comments on it. The comment names the page's
  address. Captured screenshots open in the same picture view, with Comment.
- The desktop browser's own element and region annotations still work as
  before.
- **Browser tasks** ([browser-tasks.md](browser-tasks.md)): a browser-use task
  runs in the same browser, so you can pin comments on the page it is on, and
  on the page it leaves when it finishes.

## What goes wrong

- **No Comment button:** no chat is open to take the comment. Open a chat
  first.
- **"The comment was not sent":** the chat could not take it (offline, or the
  run failed to start). The comment stays in the box; send it again.
- **A model that can't read images** still gets the position and, on web
  pages, the element, from the context lines.
- **The name says "this image":** the picture has no file name or alt text,
  for example a pasted screenshot.

## Code map

- `packages/client/src/utils/pin-comment.ts`: the message text, the spot as
  whole percentages, and the chat the comments go to (`ChatPanel.vue` sets it).
- `packages/client/src/components/common/PinComment.vue`: the pin layer and
  popover around a picture.
- Used in `ImagePreviewOverlay.vue` and `BrowserPanel.vue`. The browser's
  element lookup is `POST /api/studio/browser/element-at` (`elementAt` in
  `headless-browser-service.ts`).
- Tests: `tests/client/pin-comment.test.ts`, `tests/e2e/pin-comment.spec.ts`.
