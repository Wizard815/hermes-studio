import { VsCodeGateway } from './gateway'
import { VsCodeManager } from './manager'

export { CODE_SERVER_VERSION, type VsCodeStatus } from './manager'

/** The one VS Code (code-server) Studio runs, and its /vscode/ gateway. */
export const vscodeManager = new VsCodeManager()
export const vscodeGateway = new VsCodeGateway(vscodeManager)
