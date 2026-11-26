/** Pin comments on screenshots and the browser view (utils/pin-comment.ts), in every locale. */
const en = {
  comment: 'Comment', commenting: 'Click a spot to comment', placeholder: 'Comment on this spot…', send: 'Send', cancel: 'Cancel',
  pin: 'Comment {n}', sent: 'Comment sent to the chat', failed: 'The comment was not sent: {error}', close: 'Close',
}
type Messages = typeof en

export const pinCommentMessages: Record<string, { pinComment: Messages }> = {
  en: { pinComment: en },
  zh: { pinComment: { comment: '评论', commenting: '点击一个位置来评论', placeholder: '评论这个位置…', send: '发送', cancel: '取消', pin: '评论 {n}', sent: '评论已发送到聊天', failed: '评论未发送：{error}', close: '关闭' } },
  'zh-TW': { pinComment: { comment: '留言', commenting: '點擊一個位置來留言', placeholder: '對這個位置留言…', send: '傳送', cancel: '取消', pin: '留言 {n}', sent: '留言已傳送到聊天', failed: '留言未傳送：{error}', close: '關閉' } },
  ja: { pinComment: { comment: 'コメント', commenting: 'コメントする場所をクリック', placeholder: 'この場所にコメント…', send: '送信', cancel: 'キャンセル', pin: 'コメント {n}', sent: 'コメントをチャットに送信しました', failed: 'コメントを送信できませんでした: {error}', close: '閉じる' } },
  ko: { pinComment: { comment: '댓글', commenting: '댓글을 달 위치를 클릭하세요', placeholder: '이 위치에 댓글…', send: '보내기', cancel: '취소', pin: '댓글 {n}', sent: '댓글을 채팅에 보냈습니다', failed: '댓글을 보내지 못했습니다: {error}', close: '닫기' } },
  de: { pinComment: { comment: 'Kommentieren', commenting: 'Klicke auf eine Stelle zum Kommentieren', placeholder: 'Kommentar zu dieser Stelle…', send: 'Senden', cancel: 'Abbrechen', pin: 'Kommentar {n}', sent: 'Kommentar an den Chat gesendet', failed: 'Der Kommentar wurde nicht gesendet: {error}', close: 'Schließen' } },
  es: { pinComment: { comment: 'Comentar', commenting: 'Haz clic en un punto para comentar', placeholder: 'Comenta este punto…', send: 'Enviar', cancel: 'Cancelar', pin: 'Comentario {n}', sent: 'Comentario enviado al chat', failed: 'No se envió el comentario: {error}', close: 'Cerrar' } },
  fr: { pinComment: { comment: 'Commenter', commenting: 'Cliquez sur un endroit pour commenter', placeholder: 'Commentez cet endroit…', send: 'Envoyer', cancel: 'Annuler', pin: 'Commentaire {n}', sent: 'Commentaire envoyé dans le chat', failed: 'Le commentaire n\'a pas été envoyé : {error}', close: 'Fermer' } },
  pt: { pinComment: { comment: 'Comentar', commenting: 'Clique em um ponto para comentar', placeholder: 'Comente este ponto…', send: 'Enviar', cancel: 'Cancelar', pin: 'Comentário {n}', sent: 'Comentário enviado ao chat', failed: 'O comentário não foi enviado: {error}', close: 'Fechar' } },
  ru: { pinComment: { comment: 'Комментировать', commenting: 'Нажмите на место, чтобы оставить комментарий', placeholder: 'Комментарий к этому месту…', send: 'Отправить', cancel: 'Отмена', pin: 'Комментарий {n}', sent: 'Комментарий отправлен в чат', failed: 'Комментарий не отправлен: {error}', close: 'Закрыть' } },
  tr: { pinComment: { comment: 'Yorum yap', commenting: 'Yorum için bir noktaya tıklayın', placeholder: 'Bu noktaya yorum yapın…', send: 'Gönder', cancel: 'İptal', pin: 'Yorum {n}', sent: 'Yorum sohbete gönderildi', failed: 'Yorum gönderilmedi: {error}', close: 'Kapat' } },
  ar: { pinComment: { comment: 'تعليق', commenting: 'انقر على موضع للتعليق', placeholder: 'علّق على هذا الموضع…', send: 'إرسال', cancel: 'إلغاء', pin: 'تعليق {n}', sent: 'أُرسل التعليق إلى المحادثة', failed: 'لم يُرسل التعليق: {error}', close: 'إغلاق' } },
}
