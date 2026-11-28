/** Labels for messages one chat sent another (docs/chat-messages.md), in every locale. */
const en = {
  from: 'From the chat “{name}”',
  reply: 'Reply from the chat “{name}”',
}
type ChatOriginMessages = typeof en

const table: Record<string, ChatOriginMessages> = {
  en,
  zh: { from: '来自聊天“{name}”', reply: '聊天“{name}”的回复' },
  'zh-TW': { from: '來自聊天「{name}」', reply: '聊天「{name}」的回覆' },
  ja: { from: 'チャット「{name}」から', reply: 'チャット「{name}」からの返信' },
  ko: { from: '채팅 “{name}”에서', reply: '채팅 “{name}”의 답장' },
  fr: { from: 'Du chat « {name} »', reply: 'Réponse du chat « {name} »' },
  es: { from: 'Del chat «{name}»', reply: 'Respuesta del chat «{name}»' },
  de: { from: 'Vom Chat „{name}“', reply: 'Antwort vom Chat „{name}“' },
  pt: { from: 'Do chat “{name}”', reply: 'Resposta do chat “{name}”' },
  ru: { from: 'Из чата «{name}»', reply: 'Ответ из чата «{name}»' },
  tr: { from: '“{name}” sohbetinden', reply: '“{name}” sohbetinden yanıt' },
  ar: { from: 'من المحادثة «{name}»', reply: 'رد من المحادثة «{name}»' },
}

export const chatOriginMessages: Record<string, { chatOrigin: ChatOriginMessages }> =
  Object.fromEntries(Object.entries(table).map(([locale, messages]) => [locale, { chatOrigin: messages }]))
