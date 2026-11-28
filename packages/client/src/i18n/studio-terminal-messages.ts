/** Terminal inside Studio (docs/projects.md#herdr-is-the-engine) and the Studios button, in every locale. */
const en = {
  noAgentTitle: 'No agent running for this chat',
  noAgentText: 'Terminal shows an agent\'s terminal while it works. Send this thread a message and its agent starts here; the chat itself stays in Chat.',
  studios: 'Studios',
  otherComputers: 'Other computers',
  backHere: 'Back to this computer',
  noRemoteAgents: 'No agents running there',
  unreachable: 'Can\'t reach it',
  remoteBar: '{name}: its own herdr over SSH',
}
type TerminalMessages = typeof en

const table: Record<string, TerminalMessages> = {
  en,
  zh: { noAgentTitle: '此聊天没有正在运行的代理', noAgentText: '终端在代理工作时显示它的终端。给这个线程发消息，它的代理就会在这里启动；聊天本身仍在“聊天”中。', studios: 'Studio', otherComputers: '其他电脑', backHere: '回到本机', noRemoteAgents: '那里没有正在运行的代理', unreachable: '无法连接', remoteBar: '{name}：通过 SSH 的 herdr' },
  'zh-TW': { noAgentTitle: '此聊天沒有正在執行的代理', noAgentText: '終端機會在代理工作時顯示它的終端。傳訊息給這個執行緒，它的代理就會在這裡啟動；聊天本身仍在「聊天」中。', studios: 'Studio', otherComputers: '其他電腦', backHere: '回到本機', noRemoteAgents: '那裡沒有正在執行的代理', unreachable: '無法連線', remoteBar: '{name}：透過 SSH 的 herdr' },
  ja: { noAgentTitle: 'このチャットで動いているエージェントはありません', noAgentText: 'ターミナルには作業中のエージェントの端末が表示されます。このスレッドにメッセージを送ると、ここでエージェントが起動します。チャット自体は「チャット」に残ります。', studios: 'Studio', otherComputers: '他のコンピュータ', backHere: 'このコンピュータに戻る', noRemoteAgents: 'そこで動いているエージェントはありません', unreachable: '接続できません', remoteBar: '{name}：SSH 経由の herdr' },
  ko: { noAgentTitle: '이 채팅에서 실행 중인 에이전트가 없습니다', noAgentText: '터미널은 에이전트가 작업하는 동안 그 터미널을 보여 줍니다. 이 스레드에 메시지를 보내면 여기서 에이전트가 시작되고, 채팅은 채팅 화면에 그대로 있습니다.', studios: 'Studio', otherComputers: '다른 컴퓨터', backHere: '이 컴퓨터로 돌아가기', noRemoteAgents: '그곳에서 실행 중인 에이전트가 없습니다', unreachable: '연결할 수 없습니다', remoteBar: '{name}: SSH로 연결된 herdr' },
  fr: { noAgentTitle: 'Aucun agent ne tourne pour ce chat', noAgentText: 'Terminal montre le terminal d\'un agent pendant qu\'il travaille. Envoyez un message à ce fil et son agent démarre ici ; le chat lui-même reste dans Chat.', studios: 'Studios', otherComputers: 'Autres ordinateurs', backHere: 'Revenir à cet ordinateur', noRemoteAgents: 'Aucun agent n\'y tourne', unreachable: 'Injoignable', remoteBar: '{name} : son herdr via SSH' },
  es: { noAgentTitle: 'Ningún agente en marcha para este chat', noAgentText: 'Terminal muestra la terminal de un agente mientras trabaja. Envía un mensaje a este hilo y su agente arranca aquí; el chat sigue en Chat.', studios: 'Studios', otherComputers: 'Otros equipos', backHere: 'Volver a este equipo', noRemoteAgents: 'Ningún agente en marcha allí', unreachable: 'No se puede conectar', remoteBar: '{name}: su herdr por SSH' },
  de: { noAgentTitle: 'Kein Agent läuft für diesen Chat', noAgentText: 'Terminal zeigt das Terminal eines Agenten, während er arbeitet. Schicken Sie diesem Thread eine Nachricht, dann startet sein Agent hier; der Chat selbst bleibt unter Chat.', studios: 'Studios', otherComputers: 'Andere Computer', backHere: 'Zurück zu diesem Computer', noRemoteAgents: 'Dort läuft kein Agent', unreachable: 'Nicht erreichbar', remoteBar: '{name}: sein herdr über SSH' },
  pt: { noAgentTitle: 'Nenhum agente rodando para este chat', noAgentText: 'Terminal mostra o terminal de um agente enquanto ele trabalha. Envie uma mensagem a esta thread e o agente começa aqui; o chat continua em Chat.', studios: 'Studios', otherComputers: 'Outros computadores', backHere: 'Voltar a este computador', noRemoteAgents: 'Nenhum agente rodando lá', unreachable: 'Sem conexão', remoteBar: '{name}: o herdr dele via SSH' },
  ru: { noAgentTitle: 'Для этого чата агент не запущен', noAgentText: 'Терминал показывает терминал агента, пока он работает. Отправьте этой ветке сообщение, и её агент запустится здесь; сам чат остаётся в «Чате».', studios: 'Studio', otherComputers: 'Другие компьютеры', backHere: 'Вернуться к этому компьютеру', noRemoteAgents: 'Там не запущено ни одного агента', unreachable: 'Не удаётся подключиться', remoteBar: '{name}: его herdr через SSH' },
  tr: { noAgentTitle: 'Bu sohbet için çalışan ajan yok', noAgentText: 'Terminal, çalışırken bir ajanın terminalini gösterir. Bu iş parçacığına mesaj gönderin, ajanı burada başlar; sohbetin kendisi Sohbet\'te kalır.', studios: 'Studio\'lar', otherComputers: 'Diğer bilgisayarlar', backHere: 'Bu bilgisayara dön', noRemoteAgents: 'Orada çalışan ajan yok', unreachable: 'Ulaşılamıyor', remoteBar: '{name}: SSH üzerinden herdr' },
  ar: { noAgentTitle: 'لا يعمل أي وكيل لهذه المحادثة', noAgentText: 'تعرض الطرفية طرفية الوكيل أثناء عمله. أرسل رسالة إلى هذه السلسلة فيبدأ وكيلها هنا؛ وتبقى المحادثة نفسها في الدردشة.', studios: 'الاستوديوهات', otherComputers: 'أجهزة أخرى', backHere: 'العودة إلى هذا الجهاز', noRemoteAgents: 'لا يعمل أي وكيل هناك', unreachable: 'تعذّر الوصول', remoteBar: '{name}: herdr الخاص به عبر SSH' },
}

export const studioTerminalMessages: Record<string, { studioTerminal: TerminalMessages }> =
  Object.fromEntries(Object.entries(table).map(([locale, messages]) => [locale, { studioTerminal: messages }]))
