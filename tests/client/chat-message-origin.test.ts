import { describe, expect, it } from 'vitest'
import { parseChatMessageOrigin } from '../../packages/client/src/utils/chat-message-origin'

describe('chat message origin', () => {
  it('TestChats_originFromStoredText', () => {
    expect(parseChatMessageOrigin('💬 From “Planner”: Which port?')).toEqual({ kind: 'from', chat: 'Planner', text: 'Which port?' })
    expect(parseChatMessageOrigin('↩ Reply from “Argos” to “Which port?”: 9477')).toEqual({ kind: 'reply', chat: 'Argos', text: '9477' })
    expect(parseChatMessageOrigin('↩ Reply from “Readme helper”: It is Argos.')).toEqual({ kind: 'reply', chat: 'Readme helper', text: 'It is Argos.' })
  })

  it('TestChats_originFromARawHerdrTranscript', () => {
    const raw = '<pasted_content id="b709">\n<studio_chat_message from_chat="Planner" from_id="4b1d">\nWhat is the first word?\n</studio_chat_message>\nThis message is from another Studio chat...\n</pasted_content id="b709">'
    expect(parseChatMessageOrigin(raw)).toEqual({ kind: 'from', chat: 'Planner', text: 'What is the first word?' })
  })

  it('TestChats_ordinaryMessagesAreNotChatMessages', () => {
    expect(parseChatMessageOrigin('Can you From “x”: do this')).toBeNull()
    expect(parseChatMessageOrigin('hello')).toBeNull()
  })
})
