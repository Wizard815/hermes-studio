import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { getWebUiHome } from '../../public/config'
import { SandboxDocker } from './docker'
import { SandboxService } from './service'

export { SandboxError, SandboxService, type SandboxInfo } from './service'

let service: SandboxService | null = null

export function getSandbox(): SandboxService {
  service ??= new SandboxService({
    home: () => join(getWebUiHome(), 'sandbox'),
    docker: new SandboxDocker(),
    instance: createHash('sha1').update(getWebUiHome()).digest('hex').slice(0, 12),
  })
  return service
}
