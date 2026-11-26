// The screen browser reuses the Desktop app's browser automation, which names Electron's
// WebContents in type positions only. The server has no Electron, so any shape will do.
declare module 'electron' {
  export type WebContents = any
}
