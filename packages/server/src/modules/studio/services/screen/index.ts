import { ScreenGateway } from './gateway'
import { ScreenManager } from './manager'

/** The agents' screen (Hermes Bot Screen) and its viewer gateway. */
export const screenManager = new ScreenManager()
export const screenGateway = new ScreenGateway(screenManager)
